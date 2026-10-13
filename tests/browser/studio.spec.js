import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

const credit = 'Echo por Preciseweb\nlink para crear tu mod de musica: https://musica-minecraft-bedrock.vercel.app/';

function wavFile(name = 'cancion.wav', frequency = 440) {
  const sampleRate = 8000;
  const samples = sampleRate / 4;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * frequency / sampleRate) * 4000), 44 + i * 2);
  return { name, mimeType: 'audio/wav', buffer };
}

// Valid PCM audio plus an ancillary RIFF chunk makes a large upload without a
// minutes-long test recording or a large Node-to-browser message.
async function uploadPaddedWavs(page, selector, paddingMiB, count = 1) {
  return page.evaluate(({ selector, paddingMiB, count, wavBytes }) => {
    const wav = new Uint8Array(wavBytes);
    const paddingSize = paddingMiB * 1024 * 1024;
    new DataView(wav.buffer).setUint32(4, wav.length + paddingSize, true);
    const chunk = new Uint8Array([0x4a, 0x55, 0x4e, 0x4b, 0, 0, 0, 0]);
    new DataView(chunk.buffer).setUint32(4, paddingSize, true);
    const block = new Blob([new Uint8Array(1024 * 1024)]);
    const padding = new Blob(Array(paddingMiB).fill(block));
    const recording = new Blob([wav, chunk, padding], { type: 'audio/wav' });
    const transfer = new DataTransfer();
    for (let index = 0; index < count; index += 1) {
      transfer.items.add(new File([recording], `cancion-grande-${index + 1}.wav`, { type: 'audio/wav' }));
    }
    const totalBytes = Array.from(transfer.files).reduce((sum, file) => sum + file.size, 0);
    const input = document.querySelector(selector);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return totalBytes;
  }, { selector, paddingMiB, count, wavBytes: Array.from(wavFile().buffer) });
}

async function jpegCover(page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 300;
    const context = canvas.getContext('2d');
    context.fillStyle = '#db995a';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  return { name: 'portada.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(base64, 'base64') };
}

async function pngCover(page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = '#7247b8';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'album.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function compressedAudioFixtures(page) {
  return page.evaluate(async (bytes) => {
    const { FFmpeg } = await import('/vendor/ffmpeg-0.12.15/index.js');
    const engine = new FFmpeg();
    try {
      await engine.load({
        coreURL: new URL('/vendor/core-0.12.10/ffmpeg-core.js', location.href).href,
        wasmURL: new URL('/vendor/core-0.12.10/ffmpeg-core.wasm', location.href).href,
      });
      await engine.writeFile('fixture.wav', new Uint8Array(bytes));
      const flacCode = await engine.exec(['-i', 'fixture.wav', '-c:a', 'flac', '-y', 'fixture.flac']);
      const mp3Code = await engine.exec(['-i', 'fixture.wav', '-c:a', 'libmp3lame', '-y', 'fixture.mp3']);
      if (flacCode !== 0 || mp3Code !== 0) throw new Error('Unable to encode compressed audio test fixtures.');
      return {
        flac: Array.from(await engine.readFile('fixture.flac')),
        mp3: Array.from(await engine.readFile('fixture.mp3')),
      };
    } finally {
      engine.terminate();
    }
  }, Array.from(wavFile().buffer));
}

function mp3WithArtwork(bytes, imageBytes) {
  let audio = Buffer.from(bytes);
  if (audio.subarray(0, 3).toString() === 'ID3') {
    const length = audio.subarray(6, 10).reduce((size, byte) => (size << 7) | byte, 0);
    audio = audio.subarray(10 + length);
  }
  // A real ID3v2.3 front-cover APIC frame exercises music-metadata's parser.
  const body = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3, 0]), imageBytes]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write('APIC');
  frameHeader.writeUInt32BE(body.length, 4);
  const tag = Buffer.concat([frameHeader, body]);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i += 1) header[9 - i] = (tag.length >> (i * 7)) & 0x7f;
  return { name: 'cancion-con-portada.mp3', mimeType: 'audio/mpeg', buffer: Buffer.concat([header, tag, audio]) };
}

async function configurePack(page, name = 'Discos con portada') {
  await page.locator('#modName').fill(name);
  await page.locator('#modDesc').fill('Mi música y mis portadas');
  await page.locator('#modIcon').setInputFiles(await jpegCover(page));
  await expect(page.locator('#iconPreview')).toBeVisible();
}

async function expectDiscPng(page, zip, path, expectedColor, tolerance = 0) {
  const file = zip.file(path);
  expect(file, `${path} must exist in the pack`).not.toBeNull();
  const png = await file.async('nodebuffer');
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(128);
  expect(png.readUInt32BE(20)).toBe(128);
  const pixel = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return Array.from(context.getImageData(64, 64, 1, 1).data);
  }, Array.from(png));
  expectedColor.forEach((channel, index) => expect(Math.abs(pixel[index] - channel)).toBeLessThanOrEqual(tolerance));
  expect(pixel[3]).toBe(255);
}

async function downloadZip(page, button = '#generateBtn') {
  const downloadPromise = page.waitForEvent('download');
  await page.locator(button).click();
  const download = await downloadPromise;
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  return { download, zip };
}

test('real local conversion exports a partial pack, normalized cover and credits without mutating the description', async ({ page }) => {
  const assets = { core: 0, wasm: 0, zip: 0 };
  const external = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.endsWith('/ffmpeg-core.js')) assets.core += 1;
    if (url.endsWith('/ffmpeg-core.wasm')) assets.wasm += 1;
    if (url.endsWith('/jszip-3.10.1.min.js')) assets.zip += 1;
    if (url.startsWith('http') && !url.startsWith('http://127.0.0.1:4173/')) external.push(url);
  });
  await page.goto('/');
  expect(assets).toEqual({ core: 0, wasm: 0, zip: 0 });
  const description = 'Mis canciones\nUna aventura con amigos';
  await page.locator('#modName').fill('Mi pack / aventura');
  await page.locator('#modDesc').fill(description);
  await page.locator('#modIcon').setInputFiles(await jpegCover(page));
  await expect(page.locator('#iconPreview')).toBeVisible();
  const unsafeName = '<img src=x onerror=alert(1)>.wav';
  await page.locator('#card-0 .song-input').setInputFiles(wavFile(unsafeName));
  await expect(page.locator('#card-0')).toHaveClass(/ready/);
  await expect(page.locator('#card-0 .file-name')).toHaveText(unsafeName);
  await expect(page.locator('#card-0 .file-name img')).toHaveCount(0);
  await expect(page.locator('#generateBtn')).toBeEnabled();
  const first = await downloadZip(page);
  expect(first.download.suggestedFilename()).toBe('Mi_pack_aventura.mcpack');
  const files = Object.values(first.zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort();
  expect(files).toEqual(['manifest.json', 'pack_icon.png', 'sounds/music/game/records/11.ogg', 'sounds/sound_definitions.json']);
  const manifest = JSON.parse(await first.zip.file('manifest.json').async('string'));
  expect(manifest.header.description).toBe(`${description}\n${credit}`);
  expect(manifest.modules[0].description).toBe(`${description}\n${credit}`);
  expect(manifest.header.min_engine_version).toEqual([1, 16, 0]);
  const definitions = JSON.parse(await first.zip.file('sounds/sound_definitions.json').async('string'));
  expect(Object.keys(definitions.sound_definitions)).toEqual(['record.11']);
  expect(definitions.sound_definitions['record.11']).toEqual({ category: 'record', max_distance: 64, sounds: [{ name: 'sounds/music/game/records/11', stream: true }] });
  const ogg = await first.zip.file('sounds/music/game/records/11.ogg').async('nodebuffer');
  expect(ogg.subarray(0, 4).toString()).toBe('OggS');
  expect(ogg.length).toBeGreaterThan(100);
  const png = await first.zip.file('pack_icon.png').async('nodebuffer');
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(256);
  expect(png.readUInt32BE(20)).toBe(256);
  await expect(page.locator('#modDesc')).toHaveValue(description);
  await expect(page.locator('#generateBtn')).toBeEnabled();
  const repeat = await downloadZip(page);
  const repeatedManifest = JSON.parse(await repeat.zip.file('manifest.json').async('string'));
  expect(repeatedManifest.header.description).toBe(`${description}\n${credit}`);
  await expect(page.locator('#modDesc')).toHaveValue(description);
  await page.locator('#card-1 .song-input').setInputFiles(wavFile('segunda.wav', 660));
  await expect(page.locator('#card-1')).toHaveClass(/ready/);
  await expect(page.locator('#readyCount')).toHaveText('2');
  expect(assets).toEqual({ core: 1, wasm: 1, zip: 1 });
  expect(external).toEqual([]);
});

test('clearing queued and active conversions cannot restore a removed song', async ({ page }) => {
  let releaseCore;
  let startedCore;
  const coreGate = new Promise((resolve) => { releaseCore = resolve; });
  const coreStarted = new Promise((resolve) => { startedCore = resolve; });
  let firstRequest = true;
  await page.route('**/ffmpeg-core.js', async (route) => {
    if (firstRequest) {
      firstRequest = false;
      startedCore();
      await coreGate;
    }
    await route.continue().catch(() => {});
  });
  await page.goto('/');
  await page.locator('#bulkSongs').setInputFiles([wavFile('primera.wav'), wavFile('en-espera.wav')]);
  await coreStarted;
  await expect(page.locator('#card-0')).toHaveClass(/converting/);
  await expect(page.locator('#card-1')).toHaveClass(/queued/);
  await page.locator('#card-1 .btn-close').click();
  await page.locator('#card-0 .btn-close').click();
  releaseCore();
  await expect(page.locator('#selectedCount')).toHaveText('0');
  await page.locator('#card-2 .song-input').setInputFiles(wavFile('nueva.wav'));
  await expect(page.locator('#card-2')).toHaveClass(/ready/);
  await expect(page.locator('#card-0')).toHaveClass(/empty/);
  await expect(page.locator('#card-1')).toHaveClass(/empty/);
  await expect(page.locator('#card-0 audio')).not.toHaveAttribute('src');
  await expect(page.locator('#card-1 audio')).not.toHaveAttribute('src');
  await expect(page.locator('#selectedCount')).toHaveText('1');
  await expect(page.locator('#readyCount')).toHaveText('1');
});

test('invalid and excess uploads explain what happened without silently replacing songs', async ({ page }) => {
  await page.goto('/');
  await page.locator('#bulkSongs').setInputFiles({ name: 'documento.txt', mimeType: 'text/plain', buffer: Buffer.from('No es una canción') });
  await expect(page.locator('#notice')).toContainText('archivo rechazado');
  await expect(page.locator('#notice')).toContainText('audio compatible');
  await expect(page.locator('#selectedCount')).toHaveText('0');
  await page.route('**/ffmpeg-core.js', (route) => route.abort());
  await page.locator('#bulkSongs').setInputFiles(Array.from({ length: 23 }, (_, index) => wavFile(`cancion-${index + 1}.wav`)));
  await expect(page.locator('#selectedCount')).toHaveText('22');
  await expect(page.locator('#notice')).toContainText('1 archivo no se añadió: solo hay 22 discos disponibles');
  await expect(page.locator('#card-0 .file-name')).toHaveText('cancion-1.wav');
  await expect(page.locator('#card-21 .file-name')).toHaveText('cancion-22.wav');
  await page.locator('#clearAllBtn').click();
  await expect(page.locator('#selectedCount')).toHaveText('0');
});

test('all 22 discs convert a selection above 250 MiB and download a complete pack', async ({ page }) => {
  let releaseCore;
  let startedCore;
  const coreGate = new Promise((resolve) => { releaseCore = resolve; });
  const coreStarted = new Promise((resolve) => { startedCore = resolve; });
  await page.route('**/ffmpeg-core.js', async (route) => {
    startedCore();
    await coreGate;
    await route.continue().catch(() => {});
  });
  await page.goto('/');
  await configurePack(page, 'Todos los discos');
  try {
    const totalBytes = await uploadPaddedWavs(page, '#bulkSongs', 13, 22);
    expect(totalBytes).toBeGreaterThan(250 * 1024 * 1024);
    await coreStarted;
    await expect(page.locator('#selectedCount')).toHaveText('22');
    await expect(page.locator('.disc-card:not(.empty)')).toHaveCount(22);
    await expect(page.locator('#notice')).toHaveText('22 canciones añadidas.');
    await expect(page.locator('#card-21 .file-name')).toHaveText('cancion-grande-22.wav');
    releaseCore();
    await expect(page.locator('#readyCount')).toHaveText('22');
    await expect(page.locator('.disc-card.ready')).toHaveCount(22);
    const { zip } = await downloadZip(page);
    const oggFiles = Object.values(zip.files).filter((file) => !file.dir && file.name.endsWith('.ogg'));
    expect(oggFiles).toHaveLength(22);
    for (const file of oggFiles) {
      const bytes = await file.async('nodebuffer');
      expect(bytes.subarray(0, 4).toString()).toBe('OggS');
      expect(bytes.length).toBeGreaterThan(100);
    }
    const { sound_definitions } = JSON.parse(await zip.file('sounds/sound_definitions.json').async('string'));
    expect(Object.keys(sound_definitions)).toHaveLength(22);
    for (const definition of Object.values(sound_definitions)) {
      expect(zip.file(`${definition.sounds[0].name}.ogg`)).not.toBeNull();
    }
    await page.locator('#clearAllBtn').click();
    await expect(page.locator('#selectedCount')).toHaveText('0');
    await expect(page.locator('.disc-card.empty')).toHaveCount(22);
  } finally {
    releaseCore();
  }
  await expect(page.locator('#readyCount')).toHaveText('0');
  await expect(page.locator('#generateBtn')).toBeDisabled();
});

test('a valid WAV above 100 MiB converts and downloads as a playable record', async ({ page }) => {
  await page.goto('/');
  await configurePack(page, 'Audio grande');
  const totalBytes = await uploadPaddedWavs(page, '#card-0 .song-input', 101);
  expect(totalBytes).toBeGreaterThan(100 * 1024 * 1024);
  await expect(page.locator('#card-0')).toHaveClass(/ready/);
  await expect(page.locator('#selectedCount')).toHaveText('1');
  await expect(page.locator('#generateBtn')).toBeEnabled();
  const { zip } = await downloadZip(page);
  const bytes = await zip.file('sounds/music/game/records/11.ogg').async('nodebuffer');
  expect(bytes.subarray(0, 4).toString()).toBe('OggS');
  expect(bytes.length).toBeGreaterThan(100);
  const playable = await page.locator('#card-0 audio').evaluate(async (audio) => {
    if (audio.readyState < 1) {
      await new Promise((resolve, reject) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', () => reject(new Error('The generated record is not playable.')), { once: true });
      });
    }
    return { duration: audio.duration, error: audio.error?.code || 0 };
  });
  expect(playable.error).toBe(0);
  expect(playable.duration).toBeGreaterThan(0);
});

test('a worker startup failure times out visibly and a replacement audio can recover', async ({ page }) => {
  await page.clock.install();
  await page.route('**/vendor/ffmpeg-0.12.15/worker.js', (route) => route.abort());
  await page.goto('/');
  const workerRequest = page.waitForRequest('**/vendor/ffmpeg-0.12.15/worker.js');
  await page.locator('#card-0 .song-input').setInputFiles(wavFile('fallo.wav'));
  await workerRequest;
  await expect(page.locator('#card-0')).toHaveClass(/converting/);
  await page.clock.fastForward(120_001);
  await expect(page.locator('#card-0')).toHaveClass(/error/);
  await expect(page.locator('#card-0 .disc-status')).toContainText('Cambia el archivo');
  await expect(page.locator('#generateBtn')).toBeDisabled();
  await page.unroute('**/vendor/ffmpeg-0.12.15/worker.js');
  await page.locator('#card-0 .song-input').setInputFiles(wavFile('recuperado.wav'));
  await expect(page.locator('#card-0')).toHaveClass(/ready/);
  await expect(page.locator('#readyCount')).toHaveText('1');
});

test('real MP3 and FLAC uploads both become playable Ogg audio', async ({ page }) => {
  await page.goto('/');
  const fixtures = await compressedAudioFixtures(page);
  await page.locator('#card-0 .song-input').setInputFiles({ name: 'cancion.flac', mimeType: 'audio/flac', buffer: Buffer.from(fixtures.flac) });
  await expect(page.locator('#card-0')).toHaveClass(/ready/);
  await page.locator('#card-1 .song-input').setInputFiles({ name: 'cancion.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from(fixtures.mp3) });
  await expect(page.locator('#card-1')).toHaveClass(/ready/);
  await page.locator('#modName').fill('Formatos comprimidos');
  await page.locator('#modDesc').fill('FLAC y MP3');
  await page.locator('#modIcon').setInputFiles(await jpegCover(page));
  await expect(page.locator('#generateBtn')).toBeEnabled();
  const { zip } = await downloadZip(page);
  for (const disc of ['11', '13']) {
    const bytes = await zip.file(`sounds/music/game/records/${disc}.ogg`).async('nodebuffer');
    expect(bytes.subarray(0, 4).toString()).toBe('OggS');
    expect(bytes.length).toBeGreaterThan(100);
  }
  await expect(page.locator('#readyCount')).toHaveText('2');
});

test('embedded MP3 artwork loads lazily and becomes the original disc item texture', async ({ page }) => {
  const metadataRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/vendor/metadata-12.2.0/')) metadataRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('#discCatalogStatus')).toContainText('22');
  await expect(page.locator('.disc-card')).toHaveCount(22);
  await expect(page.locator('#card-0 .song-cover-preview')).toBeHidden();
  expect(metadataRequests).toEqual([]);
  const fixtures = await compressedAudioFixtures(page);
  const artwork = await pngCover(page);
  await configurePack(page);
  await page.locator('#card-0 .song-input').setInputFiles(mp3WithArtwork(fixtures.mp3, artwork.buffer));
  await expect(page.locator('#card-0')).toHaveClass(/ready/);
  await expect(page.locator('#card-0 .song-cover-preview')).toBeVisible();
  expect(metadataRequests.length).toBeGreaterThan(0);
  const { zip } = await downloadZip(page);
  await expectDiscPng(page, zip, 'textures/items/record_11.png', [0x72, 0x47, 0xb8]);
  expect(zip.file('textures/item_texture.json')).toBeNull();
  expect(Object.values(zip.files).filter((file) => !file.dir && file.name.startsWith('textures/')).map((file) => file.name)).toEqual(['textures/items/record_11.png']);
  expect((await zip.file('sounds/music/game/records/11.ogg').async('nodebuffer')).subarray(0, 4).toString()).toBe('OggS');
});

test('manual artwork survives audio conversion, overrides modern textures and can restore the original sprite', async ({ page }) => {
  let releaseCore;
  let startedCore;
  const coreGate = new Promise((resolve) => { releaseCore = resolve; });
  const coreStarted = new Promise((resolve) => { startedCore = resolve; });
  await page.route('**/ffmpeg-core.js', async (route) => {
    startedCore();
    await coreGate;
    await route.continue();
  });
  await page.goto('/');
  await configurePack(page);
  await expect(page.locator('#card-19 .cover-action')).toBeDisabled();
  await page.locator('#card-19 .song-input').setInputFiles(wavFile('tears-personalizado.wav'));
  await coreStarted;
  await expect(page.locator('#card-19')).toHaveClass(/converting/);
  await expect(page.locator('#card-19 .cover-action')).toBeEnabled();
  await page.locator('#card-19 .song-cover-input').setInputFiles(await jpegCover(page));
  await expect(page.locator('#card-19 .song-cover-preview')).toBeVisible();
  releaseCore();
  await expect(page.locator('#card-19')).toHaveClass(/ready/);
  await expect(page.locator('#card-19 .song-cover-preview')).toBeVisible();
  const withCover = await downloadZip(page);
  await expectDiscPng(page, withCover.zip, 'textures/items/music_disc_tears.png', [0xdb, 0x99, 0x5a], 3);
  await page.locator('#card-19 .cover-remove').click();
  await expect(page.locator('#card-19 .song-cover-preview')).toBeHidden();
  const originalSprite = await downloadZip(page);
  expect(Object.values(originalSprite.zip.files).filter((file) => !file.dir && file.name.startsWith('textures/'))).toEqual([]);
  expect(originalSprite.zip.file('sounds/music/game/records/tears.ogg')).not.toBeNull();
  await page.locator('#card-19 .song-cover-input').setInputFiles(await pngCover(page));
  await expect(page.locator('#card-19 .song-cover-preview')).toBeVisible();
  const replacedCover = await downloadZip(page);
  await expectDiscPng(page, replacedCover.zip, 'textures/items/music_disc_tears.png', [0x72, 0x47, 0xb8]);
});

test('clearing and replacing a song cannot restore its pending embedded artwork', async ({ page }) => {
  let releaseMetadata;
  let startedMetadata;
  const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
  const metadataStarted = new Promise((resolve) => { startedMetadata = resolve; });
  await page.route('**/vendor/metadata-12.2.0/index.js', async (route) => {
    startedMetadata();
    await metadataGate;
    await route.continue();
  });
  await page.goto('/');
  const fixtures = await compressedAudioFixtures(page);
  const artwork = await pngCover(page);
  await configurePack(page);
  await page.locator('#card-0 .song-input').setInputFiles(mp3WithArtwork(fixtures.mp3, artwork.buffer));
  await metadataStarted;
  await page.locator('#card-0 .btn-close').click();
  await expect(page.locator('#card-0 .song-cover-preview')).toBeHidden();
  await page.locator('#card-0 .song-input').setInputFiles(wavFile('sin-portada.wav'));
  releaseMetadata();
  await expect(page.locator('#card-0')).toHaveClass(/ready/);
  await expect(page.locator('#card-0 .song-cover-status')).toContainText('Sin portada incrustada');
  await expect(page.locator('#card-0 .song-cover-preview')).toBeHidden();
  await expect(page.locator('#card-0 .file-name')).toHaveText('sin-portada.wav');
  const { zip } = await downloadZip(page);
  expect(Object.values(zip.files).filter((file) => !file.dir && file.name.startsWith('textures/'))).toEqual([]);
});

test('manual artwork unblocks conversion immediately while embedded metadata is still loading', async ({ page }) => {
  let releaseMetadata;
  let startedMetadata;
  const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
  const metadataStarted = new Promise((resolve) => { startedMetadata = resolve; });
  await page.route('**/vendor/metadata-12.2.0/index.js', async (route) => {
    startedMetadata();
    await metadataGate;
    await route.continue();
  });
  await page.goto('/');
  await configurePack(page);
  const audio = wavFile('portada-manual.wav');
  await page.locator('#card-0 .song-input').setInputFiles(audio);
  await metadataStarted;
  await page.locator('#card-0 .song-cover-input').setInputFiles(await jpegCover(page));
  await expect(page.locator('#card-0')).toHaveClass(/ready/, { timeout: 5000 });
  await expect(page.locator('#card-0 .song-cover-preview')).toBeVisible();
  await expect(page.locator('#card-0 .song-cover-status')).toContainText('Portada personalizada');
  await expect(page.locator('#generateBtn')).toBeEnabled({ timeout: 5000 });
  const whileLoading = await downloadZip(page);
  await expectDiscPng(page, whileLoading.zip, 'textures/items/record_11.png', [0xdb, 0x99, 0x5a], 3);
  releaseMetadata();
  // Complete an actual WAV parse after the module gate to settle the stale auto task.
  await page.evaluate(async (bytes) => {
    const { parseBlob } = await import('/vendor/metadata-12.2.0/index.js');
    await parseBlob(new File([new Uint8Array(bytes)], 'without-cover.wav', { type: 'audio/wav' }), { duration: false });
  }, Array.from(audio.buffer));
  await expect(page.locator('#card-0 .song-cover-status')).toContainText('Portada personalizada');
  await expect(page.locator('#card-0 .song-cover-preview')).toBeVisible();
  const afterLoading = await downloadZip(page);
  await expectDiscPng(page, afterLoading.zip, 'textures/items/record_11.png', [0xdb, 0x99, 0x5a], 3);
});

test('mobile layout fits the screen and social placeholders stay unavailable until configured', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.disc-card')).toHaveCount(22);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const network of ['instagram', 'tiktok', 'telegram']) {
    const link = page.locator(`#social-${network}`);
    await expect(link).toHaveAttribute('aria-disabled', 'true');
    await expect(link).not.toHaveAttribute('href');
    await expect(link.locator('svg')).toHaveCount(1);
  }
  await page.locator('.app-footer').scrollIntoViewIfNeeded();
  await expect(page.locator('.social-links')).toBeVisible();
  await expect(page.locator('.footer-bottom')).toContainText('Hecho por Preciseweb');
  await expect(page.locator('#mobileDownloadBar')).toBeHidden();
  await page.locator('#modName').fill('Mi pack móvil');
  await page.locator('#modDesc').fill('Canciones para llevar');
  await page.locator('#modIcon').setInputFiles(await jpegCover(page));
  await page.locator('#card-0 .song-input').setInputFiles(wavFile('movil.wav'));
  await expect(page.locator('#card-0')).toHaveClass(/ready/);
  await expect(page.locator('#mobileDownloadBar')).toBeVisible();
  await expect(page.locator('#mobileGenerateBtn')).toBeEnabled();
  await expect(page.locator('#mobilePackStatus')).toHaveText('1 canción lista');
  await page.locator('#card-21').scrollIntoViewIfNeeded();
  const bar = await page.locator('#mobileDownloadBar').boundingBox();
  expect(bar.y + bar.height).toBe(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const { download, zip } = await downloadZip(page, '#mobileGenerateBtn');
  expect(download.suggestedFilename()).toBe('Mi_pack_móvil.mcpack');
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  expect(manifest.header.description).toBe(`Canciones para llevar\n${credit}`);
  await page.locator('#clearAllBtn').click();
  await expect(page.locator('#mobileDownloadBar')).toBeHidden();
});
