const ENCODER_URL = new URL('./vendor/vorbis-0.7.0/index.js', import.meta.url).href;

let encoder;
let encoderLoading;
let active = false;
let channelCount = 0;
let pending = Promise.resolve();

async function getEncoder() {
  if (encoder) return encoder;
  if (!encoderLoading) {
    encoderLoading = import(ENCODER_URL)
      .then(({ createOggEncoder }) => createOggEncoder())
      .then((loaded) => {
        encoder = loaded;
        return loaded;
      })
      .finally(() => {
        encoderLoading = null;
      });
  }
  return encoderLoading;
}

function reply(id, output = new Uint8Array()) {
  // Encoder output belongs to its WASM heap and can be overwritten by the
  // next call. Copy only the encoded bytes before transferring ownership.
  const data = output.slice();
  self.postMessage({ id, data }, [data.buffer]);
}

async function handle(message) {
  const { id, type } = message;
  if (type === 'init') {
    const { sampleRate = 44100, channels = 2, quality = 5 } = message;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error('La frecuencia del audio no es válida.');
    }
    if (channels !== 1 && channels !== 2) {
      throw new Error('El audio debe tener uno o dos canales.');
    }
    if (!Number.isFinite(quality) || quality < -1 || quality > 10) {
      throw new Error('La calidad del audio no es válida.');
    }
    active = false;
    const instance = await getEncoder();
    // configure() frees the previous song's encoder state, while keeping the
    // small WASM module loaded for the next song.
    instance.configure({ sampleRate, channels, vbrQuality: quality });
    channelCount = channels;
    active = true;
    reply(id);
    return;
  }

  if (type === 'reset') {
    active = false;
    channelCount = 0;
    reply(id);
    return;
  }

  if (!active || !encoder) {
    throw new Error('Inicia el conversor antes de enviar audio.');
  }

  if (type === 'chunk') {
    const { channels } = message;
    if (!Array.isArray(channels) || channels.length !== channelCount ||
        channels.some((samples) => !(samples instanceof Float32Array)) ||
        channels.some((samples) => samples.length !== channels[0].length)) {
      throw new Error('Los canales del audio no son válidos.');
    }
    reply(id, encoder.encode(channels));
    return;
  }

  if (type === 'finish') {
    const output = encoder.finalize();
    active = false;
    channelCount = 0;
    reply(id, output);
    return;
  }

  throw new Error('La solicitud del conversor no es válida.');
}

self.addEventListener('message', ({ data }) => {
  // Initialization imports asynchronously. Preserve request order even if
  // callers send their next chunk before initialization has completed.
  pending = pending.then(() => handle(data)).catch((error) => {
    active = false;
    self.postMessage({
      id: data?.id,
      error: error instanceof Error ? error.message : 'No se pudo convertir el audio.'
    });
  });
});
