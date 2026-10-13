const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
let metadataLoading;

function loadMetadata() {
  if (!metadataLoading) {
    metadataLoading = import('./vendor/metadata-12.2.0/index.js').catch((error) => {
      metadataLoading = null;
      throw error;
    });
  }
  return metadataLoading;
}

// Canonical MIME types come from raster signatures, rather than untrusted tags.
// This also normalizes ID3 values such as JPG/JPEG while excluding SVG artwork.
function rasterType(bytes) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 && [55, 57].includes(bytes[4]) && bytes[5] === 97) return 'image/gif';
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  if (bytes.length >= 2 && bytes[0] === 66 && bytes[1] === 77) return 'image/bmp';
  return '';
}

/** Find embedded album artwork without loading the parser during initial page load. */
export async function extractSongCover(file) {
  const { parseBlob, selectCover } = await loadMetadata();
  const metadata = await parseBlob(file, { duration: false, skipPostHeaders: true, skipCovers: false });
  const pictures = metadata.common?.picture || [];
  const preferred = selectCover(pictures);
  // If the preferred image is unsupported, try another embedded raster cover.
  const candidates = preferred ? [preferred, ...pictures.filter((picture) => picture !== preferred)] : pictures;
  for (const picture of candidates) {
    const data = picture.data;
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_COVER_BYTES) continue;
    const type = rasterType(data);
    if (type) return new Blob([data], { type });
  }
  return null;
}

function validateDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('La portada no contiene una imagen válida.');
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error('La portada puede tener hasta 40 millones de píxeles.');
  }
}

// Check dimensions in common raster headers before asking the browser to decode.
// A second check uses actual decoded dimensions for every supported format.
function validateHeaderDimensions(bytes, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png' && bytes.length >= 24) {
    validateDimensions(view.getUint32(16), view.getUint32(20));
  } else if (type === 'image/gif' && bytes.length >= 10) {
    validateDimensions(view.getUint16(6, true), view.getUint16(8, true));
  } else if (type === 'image/bmp' && bytes.length >= 26) {
    const dibSize = view.getUint32(14, true);
    if (dibSize === 12) validateDimensions(view.getUint16(18, true), view.getUint16(20, true));
    else if (dibSize >= 40) validateDimensions(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
  } else if (type === 'image/webp' && bytes.length >= 30 && bytes[12] === 86 && bytes[13] === 80 && bytes[14] === 56) {
    if (bytes[15] === 88) {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      validateDimensions(width, height);
    } else if (bytes[15] === 76 && bytes[20] === 47) {
      const dimensions = view.getUint32(21, true);
      validateDimensions(1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff));
    } else if (bytes[15] === 32 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      validateDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
  } else if (type === 'image/jpeg') {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && segmentLength >= 8) {
        validateDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        break;
      }
      offset += segmentLength;
    }
  }
}

async function decodeCover(blob) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Some browsers support an image format through <img> but not ImageBitmap.
    }
  }
  const url = URL.createObjectURL(blob);
  let image;
  const release = () => {
    if (image) {
      image.onload = null;
      image.onerror = null;
    }
    image?.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  try {
    image = new Image();
    image.decoding = 'async';
    if (typeof image.decode === 'function') {
      image.src = url;
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('La portada no contiene una imagen válida.'));
        image.src = url;
      });
      image.onload = null;
      image.onerror = null;
    }
    return { image, width: image.naturalWidth, height: image.naturalHeight, release };
  } catch {
    release();
    throw new Error('La portada no contiene una imagen válida.');
  }
}

/** Produce a square PNG texture from an embedded or manually uploaded cover. */
export async function makePngCover(blob, size = 128) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('Elige una imagen para la portada.');
  if (blob.size > MAX_COVER_BYTES) throw new Error('La portada puede pesar hasta 10 MB.');
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new Error('El tamaño de la portada no es válido.');
  const header = new Uint8Array(await blob.slice(0, 128 * 1024).arrayBuffer());
  const type = rasterType(header);
  if (!type) throw new Error('Usa una portada PNG, JPG, WebP, GIF o BMP.');
  validateHeaderDimensions(header, type);
  // Canonicalize the Blob type when embedded tags or browsers omit/mislabel it.
  const imageBlob = blob.type === type ? blob : new Blob([blob], { type });
  const decoded = await decodeCover(imageBlob);
  let canvas;
  try {
    validateDimensions(decoded.width, decoded.height);
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Tu navegador no pudo preparar la portada.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const side = Math.min(decoded.width, decoded.height);
    context.drawImage(decoded.image, (decoded.width - side) / 2, (decoded.height - side) / 2, side, side, 0, 0, size, size);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error('No se pudo crear la portada PNG.')), 'image/png');
    });
  } finally {
    decoded.release();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
