export const SITE_URL = 'https://musica-minecraft-bedrock.vercel.app/';
export const ATTRIBUTION = `Echo por Preciseweb\nlink para crear tu mod de musica: ${SITE_URL}`;
export const DISCS = Object.freeze([
  '11', '13', 'blocks', 'cat', 'chirp', 'far', 'mall', 'mellohi', 'stal', 'strad', 'wait', 'ward',
  'pigstep', 'otherside', '5', 'relic', 'precipice', 'creator', 'creator_music_box', 'tears', 'bounce', 'lava_chicken'
]);
// Stable Bedrock 26.52; the 26.50.4 sample catalog is unchanged by the hotfixes.
export const DISC_CATALOG = Object.freeze({ version: '26.52', checkedAt: '2026-10-12' });
const MODERN_TEXTURE_DISCS = new Set(['relic', 'precipice', 'creator', 'creator_music_box', 'tears', 'bounce', 'lava_chicken']);

export function discTexturePath(disc) {
  if (!DISCS.includes(disc)) throw new Error('Disco desconocido.');
  return `textures/items/${MODERN_TEXTURE_DISCS.has(disc) ? 'music_disc' : 'record'}_${disc}.png`;
}
export const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus,.webm,.aiff,.wma';
// FFmpeg's WebAssembly build has a 2 GiB input ceiling. There is no selection-wide cap.
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024 - 1;
export const MAX_ICON_BYTES = 10 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm', 'aif', 'aiff', 'wma', 'oga', 'mp4']);

export function buildDescription(description) {
  return `${description.trim()}\n${ATTRIBUTION}`;
}

export function validateAudio(file) {
  if (!file || !file.size) return 'El archivo está vacío.';
  if (file.size > MAX_AUDIO_BYTES) return 'Cada audio debe pesar menos de 2 GB, el límite técnico del conversor del navegador.';
  const extension = file.name.split('.').pop().toLowerCase();
  if (!file.type.startsWith('audio/') && !AUDIO_EXTENSIONS.has(extension)) return 'Selecciona un archivo de audio compatible.';
  return '';
}

export function validateIcon(file) {
  if (!file || !file.size) return 'La imagen está vacía.';
  if (file.size > MAX_ICON_BYTES) return 'La portada puede pesar hasta 10 MB.';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return 'Usa una portada PNG, JPG o WebP.';
  return '';
}

export function downloadFilename(name) {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '').replace(/\s+/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80);
  return `${safe || 'Mi_musica'}.mcpack`;
}

export function buildPackMetadata(name, description, discs, uuid = () => globalThis.crypto.randomUUID()) {
  const creditedDescription = buildDescription(description);
  const versions = {
    otherside: [1, 18, 0], '5': [1, 19, 0], relic: [1, 20, 0], precipice: [1, 21, 0],
    creator: [1, 21, 0], creator_music_box: [1, 21, 0], tears: [1, 21, 90], lava_chicken: [1, 21, 93], bounce: [1, 26, 30]
  };
  const minimum = discs.reduce((current, disc) => {
    const candidate = versions[disc] || [1, 16, 0];
    return candidate[1] > current[1] || (candidate[1] === current[1] && candidate[2] > current[2]) ? candidate : current;
  }, [1, 16, 0]);
  const manifest = {
    format_version: 2,
    header: { name: name.trim(), description: creditedDescription, uuid: uuid(), version: [1, 0, 0], min_engine_version: minimum },
    modules: [{ type: 'resources', uuid: uuid(), description: creditedDescription, version: [1, 0, 0] }]
  };
  const soundDefinitions = { format_version: '1.14.0', sound_definitions: {} };
  for (const disc of discs) {
    if (!DISCS.includes(disc)) throw new Error('Disco desconocido.');
    soundDefinitions.sound_definitions[`record.${disc}`] = {
      category: 'record',
      max_distance: 64,
      sounds: [{ name: `sounds/music/game/records/${disc}`, stream: true }]
    };
  }
  return { manifest, soundDefinitions };
}
