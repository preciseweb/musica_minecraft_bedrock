const CORE_URL = new URL('./vendor/core-0.12.10/ffmpeg-core.js', import.meta.url).href;
const WASM_URL = new URL('./vendor/core-0.12.10/ffmpeg-core.wasm', import.meta.url).href;

export class AudioConverter {
  constructor() {
    this.instance = null;
    this.loading = null;
    this.generation = 0;
  }

  async load(onStage) {
    if (this.instance?.loaded) return this.instance;
    if (!this.loading) {
      onStage('Preparando el conversor por primera vez…');
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
        } finally {
          clearTimeout(loadTimer);
        }
      })();
      this.loading = pending;
      pending.finally(() => {
        if (this.loading === pending) this.loading = null;
      }).catch(() => {});
    }
    return this.loading;
  }

  async convert(file, onProgress, onStage, isCurrent = () => true) {
    const instance = await this.load(onStage);
    if (!isCurrent()) throw new Error('Conversión cancelada.');
    const input = 'input.audio';
    const output = 'output.ogg';
    const progressListener = ({ progress }) => {
      if (Number.isFinite(progress)) onProgress(Math.min(99, Math.max(3, Math.round(progress * 100))));
    };
    instance.on('progress', progressListener);
    try {
      onStage('Convirtiendo tu canción…');
      await instance.writeFile(input, new Uint8Array(await file.arrayBuffer()));
      if (!isCurrent()) throw new Error('Conversión cancelada.');
      const code = await instance.exec([
        '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1',
        '-ar', '44100', '-ac', '2', '-c:a', 'libvorbis', '-q:a', '3', '-y', output
      ], 5 * 60 * 1000);
      if (code !== 0) throw new Error('No se pudo convertir. Prueba otro archivo de audio.');
      const data = await instance.readFile(output);
      return new Blob([data], { type: 'audio/ogg' });
    } finally {
      instance.off('progress', progressListener);
      if (instance.loaded) {
        await Promise.allSettled([instance.deleteFile(input), instance.deleteFile(output)]);
      }
    }
  }

  cancel() {
    this.generation += 1;
    this.instance?.terminate();
    this.instance = null;
    this.loading = null;
  }
}
