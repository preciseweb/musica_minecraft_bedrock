import { inspectSongAudio } from './artwork.js';

const CORE_URL = new URL('./vendor/core-0.12.10/ffmpeg-core.js', import.meta.url).href;
const WASM_URL = new URL('./vendor/core-0.12.10/ffmpeg-core.wasm', import.meta.url).href;
const SAMPLE_RATE = 44100;
const QUALITY = 5;
const MAX_NATIVE_INPUT = 64 * 1024 * 1024;
const MAX_NATIVE_PCM = 128 * 1024 * 1024;
const PCM_CHUNK_FRAMES = 262144;

function oggPage(bytes, offset) {
  if (offset + 27 > bytes.length || bytes[offset] !== 79 || bytes[offset + 1] !== 103 || bytes[offset + 2] !== 103 || bytes[offset + 3] !== 83 || bytes[offset + 4] !== 0) return null;
  const count = bytes[offset + 26];
  if (!count || offset + 27 + count > bytes.length) return null;
  let length = 27 + count;
  for (let i = 0; i < count; i += 1) length += bytes[offset + 27 + i];
  if (offset + length > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  return { length, body: offset + 27 + count, flags: bytes[offset + 5], serial: view.getUint32(14, true) };
}

// Check the actual codec: an OGG containing Opus still requires conversion.
async function compatibleVorbis(file) {
  const first = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const page = oggPage(first, 0);
  if (!page || !(page.flags & 2)) return false;
  const packet = first.subarray(page.body, page.body + 30);
  if (packet.length < 30 || packet[0] !== 1 || String.fromCharCode(...packet.subarray(1, 7)) !== 'vorbis') return false;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.length);
  const rate = view.getUint32(12, true);
  if (view.getUint32(7, true) !== 0 || ![1, 2].includes(packet[11]) || rate < 8000 || rate > 192000 || !(packet[29] & 1)) return false;
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 131072)).arrayBuffer());
  for (let offset = tail.length - 27; offset >= 0; offset -= 1) {
    const end = oggPage(tail, offset);
    if (end && offset + end.length === tail.length && (end.flags & 4) && end.serial === page.serial) return true;
  }
  return false;
}

export class AudioConverter {
  constructor() {
    this.instance = null;
    this.loading = null;
    this.generation = 0;
    this.worker = null;
    this.requests = new Map();
    this.requestId = 0;
  }

  stopNative() {
    this.worker?.terminate();
    this.worker = null;
    for (const { reject, timer } of this.requests.values()) {
      clearTimeout(timer);
      reject(new Error('La conversión se interrumpió.'));
    }
    this.requests.clear();
  }

  nativeRequest(type, data = {}, transfers = []) {
    if (!this.worker) {
      const worker = new Worker(new URL('./vorbis-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: response }) => {
        const request = this.requests.get(response.id);
        if (!request) return;
        this.requests.delete(response.id);
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error(response.error));
        else request.resolve(response.data);
      };
      worker.onerror = () => { if (this.worker === worker) this.stopNative(); };
      worker.onmessageerror = () => { if (this.worker === worker) this.stopNative(); };
      this.worker = worker;
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stopNative(), type === 'init' ? 45_000 : 60_000);
      this.requests.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, type, ...data }, transfers); }
      catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(error);
      }
    });
  }

  async convertNatively(file, onProgress, onStage, isCurrent) {
    const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Context || file.size > MAX_NATIVE_INPUT) throw new Error('Usar conversión compatible.');
    let metadataTimer;
    let info;
    try {
      info = await Promise.race([
        inspectSongAudio(file).catch(() => ({})),
        new Promise((resolve) => { metadataTimer = setTimeout(() => resolve({}), 750); })
      ]);
    } finally { clearTimeout(metadataTimer); }
    if (!isCurrent()) throw new Error('Conversión cancelada.');
    const duration = info.duration || (info.bitrate ? file.size * 8 / info.bitrate : 0);
    if ((info.numberOfChannels && info.numberOfChannels > 2) || duration * SAMPLE_RATE * 2 * 4 > MAX_NATIVE_PCM || (!duration && file.size > 16 * 1024 * 1024)) {
      throw new Error('Usar conversión por fragmentos.');
    }
    onStage('Leyendo audio con el navegador…');
    let context = new Context(2, 1, SAMPLE_RATE);
    let buffer;
    try { buffer = await context.decodeAudioData(await file.arrayBuffer()); }
    finally { context = null; }
    if (!isCurrent()) throw new Error('Conversión cancelada.');
    if (buffer.numberOfChannels > 2 || buffer.length * buffer.numberOfChannels * 4 > MAX_NATIVE_PCM) throw new Error('Usar conversión por fragmentos.');
    const channels = buffer.numberOfChannels;
    onProgress(10);
    onStage('Creando OGG de alta calidad…');
    const parts = [];
    const header = await this.nativeRequest('init', { sampleRate: buffer.sampleRate, channels, quality: QUALITY });
    if (header.length) parts.push(header);
    const pcm = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
    for (let offset = 0; offset < buffer.length; offset += PCM_CHUNK_FRAMES) {
      if (!isCurrent()) throw new Error('Conversión cancelada.');
      const end = Math.min(buffer.length, offset + PCM_CHUNK_FRAMES);
      const chunk = pcm.map((channel) => channel.slice(offset, end));
      const data = await this.nativeRequest('chunk', { channels: chunk }, chunk.map((channel) => channel.buffer));
      if (data.length) parts.push(data);
      onProgress(Math.min(99, 10 + Math.round(end / buffer.length * 89)));
    }
    const end = await this.nativeRequest('finish');
    if (end.length) parts.push(end);
    return new Blob(parts, { type: 'audio/ogg' });
  }

  async load(onStage) {
    if (this.instance?.loaded) return this.instance;
    if (!this.loading) {
      onStage('Preparando conversión compatible…');
      const generation = this.generation;
      const pending = (async () => {
        const { FFmpeg } = await import('./vendor/ffmpeg-0.12.15/index.js');
        if (generation !== this.generation) throw new Error('Conversión cancelada.');
        const instance = new FFmpeg();
        this.instance = instance;
        let loadTimer;
        try {
          const timeout = new Promise((_, reject) => {
            loadTimer = setTimeout(() => {
              instance.terminate();
              reject(new Error('La carga del conversor tardó demasiado. Revisa tu conexión e inténtalo de nuevo.'));
            }, 120_000);
          });
          await Promise.race([instance.load({ coreURL: CORE_URL, wasmURL: WASM_URL }), timeout]);
          return instance;
        } catch (error) {
          if (this.instance === instance) this.instance = null;
          instance.terminate();
          throw error;
        } finally { clearTimeout(loadTimer); }
      })();
      this.loading = pending;
      pending.finally(() => {
        if (this.loading === pending) this.loading = null;
      }).catch(() => {});
    }
    return this.loading;
  }

  async convertCompatibly(file, onProgress, onStage, isCurrent) {
    const instance = await this.load(onStage);
    if (!isCurrent()) throw new Error('Conversión cancelada.');
    const inputDirectory = '/input';
    const input = `${inputDirectory}/input.audio`;
    const output = 'output.ogg';
    let directoryCreated = false;
    let mounted = false;
    const progressListener = ({ progress }) => {
      if (Number.isFinite(progress)) onProgress(Math.min(99, Math.max(3, Math.round(progress * 100))));
    };
    instance.on('progress', progressListener);
    try {
      onStage('Convirtiendo tu canción…');
      await instance.createDir(inputDirectory);
      directoryCreated = true;
      mounted = await instance.mount('WORKERFS', { blobs: [{ name: 'input.audio', data: file }] }, inputDirectory);
      if (!mounted) throw new Error('El conversor no pudo abrir el archivo de audio.');
      if (!isCurrent()) throw new Error('Conversión cancelada.');
      const code = await instance.exec([
        '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1',
        '-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'libvorbis', '-q:a', String(QUALITY), '-y', output
      ]);
      if (code !== 0) throw new Error('No se pudo convertir. Prueba otro archivo de audio.');
      return new Blob([await instance.readFile(output)], { type: 'audio/ogg' });
    } finally {
      instance.off('progress', progressListener);
      if (instance.loaded) {
        await Promise.allSettled([instance.deleteFile(output), ...(mounted ? [instance.unmount(inputDirectory)] : [])]);
        if (directoryCreated && instance.loaded) await instance.deleteDir(inputDirectory).catch(() => {});
      }
    }
  }

  async convert(file, onProgress, onStage, isCurrent = () => true) {
    const generation = this.generation;
    const current = () => generation === this.generation && isCurrent();
    if (await compatibleVorbis(file)) {
      if (!current()) throw new Error('Conversión cancelada.');
      onStage('OGG compatible: conservando el audio original…');
      onProgress(99);
      return new Blob([file], { type: 'audio/ogg' });
    }
    if (!current()) throw new Error('Conversión cancelada.');
    try { return await this.convertNatively(file, onProgress, onStage, current); }
    catch (error) {
      if (!current()) throw error;
      this.stopNative();
      return this.convertCompatibly(file, onProgress, onStage, current);
    }
  }

  cancel() {
    this.generation += 1;
    this.stopNative();
    this.instance?.terminate();
    this.instance = null;
    this.loading = null;
  }
}
