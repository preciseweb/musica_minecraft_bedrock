import { DISCS, DISC_CATALOG, AUDIO_ACCEPT, buildDescription, buildPackMetadata, discTexturePath, downloadFilename, validateAudio, validateIcon } from './pack.js';
import { AudioConverter } from './converter.js';
import { extractSongCover, makePngCover } from './artwork.js';
import { SOCIAL_LINKS } from './social-links.js';

const $ = (id) => document.getElementById(id);
const slots = DISCS.map((discName) => ({
  discName, revision: 0, file: null, blob: null, url: '', status: 'empty', progress: 0, error: '',
  coverRevision: 0, coverBlob: null, coverUrl: '', coverPending: false, coverStatus: 'empty', coverSource: ''
}));
const cards = [];
const coverCancellations = new Map();
const converter = new AudioConverter();
let queue = [];
let processing = false;
let activeJob = null;
let packaging = false;
let iconBlob = null;
let iconUrl = '';
let iconRevision = 0;
let zipLoading = null;
let stageMessage = '';
let completedDownload = '';

function showNotice(message, error = false) {
  $('notice').hidden = !message;
  $('notice').textContent = message;
  $('notice').classList.toggle('notice-error', error);
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function updateSummary() {
  const selected = slots.filter((slot) => slot.file);
  const ready = selected.filter((slot) => slot.status === 'ready');
  const errors = selected.filter((slot) => slot.status === 'error');
  const converting = selected.some((slot) => ['queued', 'converting'].includes(slot.status));
  const pending = converting || selected.some((slot) => slot.coverPending);
  $('readyCount').textContent = ready.length;
  $('selectedCount').textContent = selected.length;
  $('clearAllBtn').disabled = !selected.length || packaging;
  $('bulkUploadBtn').disabled = packaging;
  $('bulkSongs').disabled = packaging;
  if (!packaging) {
    $('globalProgress').value = selected.length ? selected.reduce((sum, slot) => sum + slot.progress, 0) / selected.length : 0;
    $('globalStatus').textContent = pending ? converting ? stageMessage || 'Canciones en espera…' : 'Preparando la portada del disco…'
      : errors.length ? `${errors.length} ${errors.length === 1 ? 'audio necesita' : 'audios necesitan'} atención.`
      : ready.length ? completedDownload || `${ready.length} ${ready.length === 1 ? 'canción lista' : 'canciones listas'} para tu mundo.`
      : 'Elige tus primeras canciones.';
  }
  const metadataReady = $('modName').value.trim() && $('modDesc').value.trim() && $('packForm').checkValidity();
  const canGenerate = metadataReady && iconBlob && ready.length && !pending && !errors.length && !packaging;
  $('generateBtn').disabled = !canGenerate;
  $('generateBtn').textContent = packaging ? 'Preparando descarga…' : 'Descargar .mcpack';
  $('mobileDownloadBar').hidden = !selected.length;
  $('mobileGenerateBtn').disabled = !canGenerate;
  $('mobileGenerateBtn').textContent = packaging ? 'Preparando…' : 'Descargar .mcpack';
  $('mobilePackStatus').textContent = pending ? 'Convirtiendo tus canciones…' : canGenerate
    ? `${ready.length} ${ready.length === 1 ? 'canción lista' : 'canciones listas'}`
    : errors.length ? 'Revisa los audios con error' : 'Completa los datos de tu pack';
  $('packHint').textContent = packaging ? 'Estamos preparando tu paquete. Espera a que termine la descarga.'
    : pending ? 'Espera a que tus canciones y portadas terminen de prepararse.'
    : errors.length ? 'Cambia o elimina los audios con error para continuar.'
    : !selected.length ? 'Añade al menos una canción. No necesitas llenar todos los discos.'
    : !metadataReady || !iconBlob ? 'Completa el nombre, la descripción y la portada para descargar.'
    : 'Abre el archivo descargado con Minecraft y activa el paquete en tu mundo.';
}

function updateCard(index) {
  const slot = slots[index];
  const refs = cards[index];
  refs.card.className = `disc-card ${slot.status}`;
  refs.card.setAttribute('aria-busy', String(slot.status === 'converting'));
  refs.filename.textContent = slot.file?.name || 'Conserva su música original';
  refs.filename.title = slot.file?.name || '';
  refs.status.textContent = {
    empty: 'Sin canción', queued: 'En espera', converting: `Convirtiendo · ${slot.progress}%`,
    ready: `Listo · ${formatBytes(slot.blob?.size || 0)}`, error: slot.error || 'No se pudo convertir'
  }[slot.status];
  refs.progress.value = slot.progress;
  refs.progress.hidden = !['queued', 'converting'].includes(slot.status);
  refs.clear.disabled = !slot.file || packaging;
  refs.upload.disabled = packaging;
  refs.input.disabled = packaging;
  refs.upload.textContent = slot.file ? 'Cambiar audio' : 'Elegir audio';
  refs.audio.hidden = slot.status !== 'ready';
  refs.artwork.hidden = !slot.file;
  refs.coverUpload.disabled = !slot.file || packaging;
  refs.coverInput.disabled = !slot.file || packaging;
  refs.coverRemove.disabled = packaging;
  refs.coverRemove.hidden = !slot.coverBlob && !slot.coverPending;
  refs.coverUpload.textContent = slot.coverBlob ? 'Cambiar portada' : 'Añadir portada';
  refs.coverStatus.textContent = slot.coverPending ? 'Preparando portada…' : {
    empty: '', queued: 'Buscaremos la portada de tu canción.', embedded: 'Portada de la canción · textura del disco',
    manual: 'Portada personalizada · textura del disco', missing: 'Sin portada incrustada. Puedes añadir una imagen.',
    original: 'Se conservará la textura original del disco.', error: 'No pudimos leer la portada. Puedes añadir una imagen.'
  }[slot.coverStatus];
  refs.coverPreview.hidden = !slot.coverUrl;
  refs.discPlaceholder.hidden = Boolean(slot.coverUrl);
  refs.discIcon.classList.toggle('has-cover', Boolean(slot.coverUrl));
  if (slot.coverUrl && refs.coverPreview.getAttribute('src') !== slot.coverUrl) refs.coverPreview.src = slot.coverUrl;
  if (!slot.coverUrl) refs.coverPreview.removeAttribute('src');
  if (slot.url && refs.audio.getAttribute('src') !== slot.url) refs.audio.src = slot.url;
  if (!slot.url && refs.audio.hasAttribute('src')) {
    refs.audio.pause();
    refs.audio.removeAttribute('src');
    refs.audio.load();
  }
  updateSummary();
}

function initGrid() {
  const fragment = document.createDocumentFragment();
  slots.forEach((slot, index) => {
    const card = document.createElement('article');
    card.id = `card-${index}`;
    card.className = 'disc-card empty';
    // Only fixed disc identifiers are interpolated. Uploaded filenames always use textContent.
    card.innerHTML = `
      <div class="card-header">
        <div class="disc-icon" aria-hidden="true"><span></span><img class="song-cover-preview" alt="" hidden></div>
        <div class="disc-info"><span class="disc-index">DISCO ${String(index + 1).padStart(2, '0')}</span><h3>${slot.discName.replaceAll('_', ' ')}</h3></div>
        <button type="button" class="btn-close" aria-label="Quitar audio del disco ${slot.discName}" disabled>×</button>
      </div>
      <p class="file-name"></p>
      <p class="disc-status"></p>
      <progress class="card-progress" max="100" value="0" aria-label="Conversión del disco ${slot.discName}" hidden></progress>
      <audio class="audio-preview" controls preload="none" aria-label="Escuchar audio del disco ${slot.discName}" hidden></audio>
      <div class="card-actions"><button type="button" class="btn-action secondary">Elegir audio</button><input class="song-input" type="file" accept="${AUDIO_ACCEPT}" hidden aria-label="Audio del disco ${slot.discName}"></div>
      <div class="song-artwork" hidden>
        <p class="song-cover-status"></p>
        <div class="song-cover-actions"><button type="button" class="cover-action" aria-label="Elegir portada del disco ${slot.discName}">Añadir portada</button><button type="button" class="cover-remove" aria-label="Usar textura original del disco ${slot.discName}" hidden>Usar original</button></div>
        <input class="song-cover-input" type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Portada del disco ${slot.discName}">
      </div>`;
    const refs = {
      card, filename: card.querySelector('.file-name'), status: card.querySelector('.disc-status'),
      progress: card.querySelector('progress'), clear: card.querySelector('.btn-close'),
      upload: card.querySelector('.btn-action'), input: card.querySelector('.song-input'), audio: card.querySelector('audio'),
      artwork: card.querySelector('.song-artwork'), coverStatus: card.querySelector('.song-cover-status'),
      coverUpload: card.querySelector('.cover-action'), coverInput: card.querySelector('.song-cover-input'), coverRemove: card.querySelector('.cover-remove'),
      coverPreview: card.querySelector('.song-cover-preview'), discIcon: card.querySelector('.disc-icon'), discPlaceholder: card.querySelector('.disc-icon > span')
    };
    refs.clear.addEventListener('click', () => clearSlot(index));
    refs.upload.addEventListener('click', () => refs.input.click());
    refs.input.addEventListener('change', () => {
      if (refs.input.files[0]) assignFile(refs.input.files[0], index);
      refs.input.value = '';
    });
    refs.coverUpload.addEventListener('click', () => refs.coverInput.click());
    refs.coverInput.addEventListener('change', () => {
      if (refs.coverInput.files[0]) void prepareManualCover(refs.coverInput.files[0], index);
      refs.coverInput.value = '';
    });
    refs.coverRemove.addEventListener('click', () => {
      if (packaging) return;
      slot.coverRevision += 1;
      coverCancellations.get(index)?.();
      if (slot.coverUrl) URL.revokeObjectURL(slot.coverUrl);
      Object.assign(slot, { coverBlob: null, coverUrl: '', coverPending: false, coverStatus: 'original', coverSource: 'original' });
      completedDownload = '';
      updateCard(index);
    });
    cards.push(refs);
    fragment.append(card);
  });
  $('discsGrid').append(fragment);
  $('totalDiscs').textContent = DISCS.length;
  $('discCatalogStatus').textContent = `${DISCS.length} discos de Minecraft Bedrock ${DISC_CATALOG.version} · Verificado el 12 de octubre de 2026`;
  slots.forEach((_, index) => updateCard(index));
}

function clearSlot(index, announce = true) {
  if (packaging) return;
  const slot = slots[index];
  slot.revision += 1;
  slot.coverRevision += 1;
  coverCancellations.get(index)?.();
  queue = queue.filter((job) => job.index !== index);
  if (activeJob?.index === index) converter.cancel();
  if (slot.url) URL.revokeObjectURL(slot.url);
  if (slot.coverUrl) URL.revokeObjectURL(slot.coverUrl);
  Object.assign(slot, {
    file: null, blob: null, url: '', status: 'empty', progress: 0, error: '',
    coverBlob: null, coverUrl: '', coverPending: false, coverStatus: 'empty', coverSource: ''
  });
  completedDownload = '';
  stageMessage = '';
  updateCard(index);
  if (announce) showNotice(`Audio eliminado del disco ${slot.discName}.`);
}

function assignFile(file, index, announce = true) {
  if (packaging) return false;
  const validationError = validateAudio(file);
  if (validationError) {
    showNotice(`${file.name}: ${validationError}`, true);
    return false;
  }
  clearSlot(index, false);
  const slot = slots[index];
  Object.assign(slot, { file, status: 'queued', coverStatus: 'queued' });
  queue.push({ index, revision: slot.revision, file });
  updateCard(index);
  if (announce) showNotice(`Añadido ${file.name} al disco ${slot.discName}.`);
  void processQueue();
  return true;
}

function addFiles(files) {
  if (packaging) return;
  let accepted = 0;
  let rejected = 0;
  let excess = 0;
  let lastError = '';
  for (const file of files) {
    const index = slots.findIndex((slot) => !slot.file);
    if (index < 0) { excess += 1; continue; }
    if (assignFile(file, index, false)) accepted += 1;
    else { rejected += 1; lastError = $('notice').textContent; }
  }
  const messages = [];
  if (accepted) messages.push(`${accepted} ${accepted === 1 ? 'canción añadida' : 'canciones añadidas'}.`);
  if (excess) messages.push(`${excess} ${excess === 1 ? 'archivo no se añadió' : 'archivos no se añadieron'}: solo hay ${DISCS.length} discos disponibles.`);
  if (rejected) messages.push(`${rejected} ${rejected === 1 ? 'archivo rechazado' : 'archivos rechazados'}. ${lastError}`);
  showNotice(messages.join(' '), Boolean(rejected || excess));
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const slot = slots[job.index];
      const isCurrent = () => slot.revision === job.revision && slot.file === job.file;
      if (!isCurrent()) continue;
      activeJob = job;
      slot.status = 'converting';
      slot.progress = 1;
      updateCard(job.index);
      const artworkTask = prepareEmbeddedCover(job);
      try {
        const blob = await converter.convert(job.file, (progress) => {
          if (!isCurrent()) return;
          slot.progress = Math.max(slot.progress, progress);
          updateCard(job.index);
        }, (message) => {
          if (!isCurrent()) return;
          stageMessage = `${slot.discName}: ${message}`;
          updateSummary();
        }, isCurrent);
        await artworkTask;
        if (!isCurrent()) continue;
        slot.blob = blob;
        slot.url = URL.createObjectURL(blob);
        slot.status = 'ready';
        slot.progress = 100;
      } catch (error) {
        if (!isCurrent()) continue;
        console.error('Error de conversión:', error);
        converter.cancel();
        slot.status = 'error';
        slot.progress = 0;
        slot.error = 'No se pudo leer este audio. Cambia el archivo o vuelve a intentarlo.';
        showNotice(`${slot.file.name}: ${slot.error}`, true);
      } finally {
        activeJob = null;
        if (isCurrent()) updateCard(job.index);
      }
    }
  } finally {
    processing = false;
    stageMessage = '';
    updateSummary();
  }
}

function setSongCover(index, blob, source) {
  const slot = slots[index];
  if (slot.coverUrl) URL.revokeObjectURL(slot.coverUrl);
  Object.assign(slot, {
    coverBlob: blob, coverUrl: blob ? URL.createObjectURL(blob) : '',
    coverPending: false, coverStatus: source, coverSource: source === 'missing' || source === 'error' ? '' : source
  });
  completedDownload = '';
  updateCard(index);
}

async function prepareEmbeddedCover(job) {
  const slot = slots[job.index];
  if (slot.coverSource === 'manual' || slot.coverSource === 'original') return;
  const coverRevision = slot.coverRevision;
  const isCurrent = () => slot.revision === job.revision && slot.coverRevision === coverRevision && slot.file === job.file;
  slot.coverPending = true;
  updateCard(job.index);
  let timer;
  let cancel;
  const cancelled = new Promise((resolve) => { cancel = () => resolve(null); });
  coverCancellations.set(job.index, cancel);
  try {
    const work = (async () => {
      const image = await extractSongCover(job.file);
      if (!image || !isCurrent()) return null;
      return makePngCover(image, 128);
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('La portada tardó demasiado en leerse.')), 20_000); });
    const png = await Promise.race([work, timeout, cancelled]);
    if (isCurrent()) setSongCover(job.index, png, png ? 'embedded' : 'missing');
  } catch {
    if (isCurrent()) setSongCover(job.index, null, 'error');
  } finally {
    clearTimeout(timer);
    if (coverCancellations.get(job.index) === cancel) coverCancellations.delete(job.index);
  }
}

async function prepareManualCover(file, index) {
  const slot = slots[index];
  if (packaging || !slot.file) return;
  const error = validateIcon(file);
  if (error) { showNotice(error, true); return; }
  const revision = ++slot.coverRevision;
  coverCancellations.get(index)?.();
  const songRevision = slot.revision;
  const previousSource = slot.coverSource;
  const previousStatus = slot.coverStatus;
  slot.coverSource = 'manual';
  slot.coverPending = true;
  completedDownload = '';
  updateCard(index);
  const isCurrent = () => slot.coverRevision === revision && slot.revision === songRevision;
  try {
    const png = await makePngCover(file, 128);
    if (isCurrent()) {
      setSongCover(index, png, 'manual');
      showNotice(`La portada reemplazará la textura del disco ${slot.discName} en Minecraft.`);
    }
  } catch {
    if (isCurrent()) {
      slot.coverSource = previousSource;
      slot.coverStatus = slot.coverBlob ? previousStatus : 'error';
      slot.coverPending = false;
      updateCard(index);
      showNotice('No pudimos abrir esa portada. Prueba otra imagen PNG, JPG o WebP.', true);
    }
  }
}

async function prepareIcon(file) {
  const revision = ++iconRevision;
  iconBlob = null;
  if (iconUrl) URL.revokeObjectURL(iconUrl);
  iconUrl = '';
  $('iconPreview').hidden = true;
  $('iconPreview').removeAttribute('src');
  $('iconPlaceholder').hidden = false;
  $('iconName').textContent = 'Preparando portada…';
  updateSummary();
  const error = validateIcon(file);
  if (error) {
    $('modIcon').value = '';
    $('iconName').textContent = 'Elige otra imagen';
    showNotice(error, true);
    return;
  }
  try {
    const png = await makePngCover(file, 256);
    if (revision !== iconRevision) return;
    iconBlob = png;
    iconUrl = URL.createObjectURL(png);
    $('iconPreview').src = iconUrl;
    $('iconPreview').hidden = false;
    $('iconPlaceholder').hidden = true;
    $('iconName').textContent = file.name;
    showNotice('Portada lista. Se guardará como PNG de 256 × 256 píxeles.');
  } catch {
    if (revision !== iconRevision) return;
    $('modIcon').value = '';
    $('iconName').textContent = 'Elige otra imagen';
    showNotice('No pudimos abrir esa imagen. Prueba otra portada PNG, JPG o WebP.', true);
  } finally {
    if (revision === iconRevision) updateSummary();
  }
}

function loadZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!zipLoading) {
    zipLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('./vendor/jszip-3.10.1.min.js', import.meta.url).href;
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => { script.remove(); zipLoading = null; reject(new Error('No se pudo cargar el empaquetador. Inténtalo de nuevo.')); };
      document.head.append(script);
    });
  }
  return zipLoading;
}

async function generatePack() {
  if (packaging || $('generateBtn').disabled) return;
  if (!$('packForm').reportValidity() || !iconBlob) return;
  const selected = slots.filter((slot) => slot.status === 'ready');
  if (!selected.length || slots.some((slot) => slot.file && (slot.status !== 'ready' || slot.coverPending))) return;
  packaging = true;
  const name = $('modName').value.trim();
  const description = $('modDesc').value;
  const cover = iconBlob;
  const fields = [...$('packForm').elements];
  fields.forEach((field) => { field.disabled = true; });
  slots.forEach((_, index) => updateCard(index));
  $('globalStatus').textContent = 'Preparando tu paquete…';
  showNotice('');
  try {
    const JSZip = await loadZip();
    const zip = new JSZip();
    const { manifest, soundDefinitions } = buildPackMetadata(name, description, selected.map((slot) => slot.discName));
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('pack_icon.png', cover);
    zip.file('sounds/sound_definitions.json', JSON.stringify(soundDefinitions, null, 2));
    selected.forEach((slot) => {
      zip.file(`sounds/music/game/records/${slot.discName}.ogg`, slot.blob);
      if (slot.coverBlob) zip.file(discTexturePath(slot.discName), slot.coverBlob);
    });
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true }, ({ percent }) => {
      $('globalProgress').value = percent;
      $('globalStatus').textContent = `Empaquetando · ${Math.round(percent)}%`;
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFilename(name);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Give mobile browsers time to consume the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    completedDownload = 'Tu paquete está listo. Descarga iniciada.';
    showNotice(`Descarga iniciada: ${anchor.download} (${formatBytes(blob.size)}). Ábrelo con Minecraft para importarlo.`);
  } catch (error) {
    console.error('Error al empaquetar:', error);
    showNotice(error.message || 'No se pudo crear el paquete. Inténtalo de nuevo.', true);
  } finally {
    packaging = false;
    fields.forEach((field) => { field.disabled = false; });
    slots.forEach((_, index) => updateCard(index));
  }
}

function initSocialLinks() {
  let activeCount = 0;
  const labels = { instagram: 'Instagram', tiktok: 'TikTok', telegram: 'Telegram' };
  for (const [network, value] of Object.entries(SOCIAL_LINKS)) {
    const link = $(`social-${network}`);
    if (!link) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') continue;
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.removeAttribute('aria-disabled');
      link.title = `Abrir ${network}`;
      link.classList.add('is-active');
      link.setAttribute('aria-label', `${labels[network]} de Preciseweb`);
      activeCount += 1;
    } catch { /* Unconfigured profiles remain visibly unavailable. */ }
  }
  if (activeCount) document.querySelector('.social-area > p > span').textContent = 'Más música y novedades';
}

$('packForm').addEventListener('submit', (event) => event.preventDefault());
$('packForm').addEventListener('input', () => {
  completedDownload = '';
  $('descriptionPreview').textContent = buildDescription($('modDesc').value || 'Tu descripción aparecerá aquí.');
  updateSummary();
});
$('modIcon').addEventListener('change', () => {
  if ($('modIcon').files[0]) void prepareIcon($('modIcon').files[0]);
});
$('bulkUploadBtn').addEventListener('click', () => $('bulkSongs').click());
$('bulkSongs').addEventListener('change', () => {
  addFiles($('bulkSongs').files);
  $('bulkSongs').value = '';
});
$('clearAllBtn').addEventListener('click', () => {
  slots.forEach((_, index) => clearSlot(index, false));
  showNotice('Se eliminaron todos los audios. Puedes empezar otra selección.');
});
$('generateBtn').addEventListener('click', () => void generatePack());
$('mobileGenerateBtn').addEventListener('click', () => void generatePack());
$('discsGrid').addEventListener('play', (event) => {
  for (const { audio } of cards) if (audio !== event.target) audio.pause();
}, true);
let dragDepth = 0;
for (const name of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  $('dropZone').addEventListener(name, (event) => {
    event.preventDefault();
    if (packaging) return;
    if (name === 'dragenter') dragDepth += 1;
    if (name === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
    if (name === 'drop') {
      dragDepth = 0;
      addFiles(event.dataTransfer.files);
    }
    $('dropZone').classList.toggle('drag-over', dragDepth > 0);
  });
}
// Prevent a dropped file outside the upload area from navigating away from the studio.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
window.addEventListener('beforeunload', (event) => {
  if (processing || packaging) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('pagehide', () => {
  converter.cancel();
});

initGrid();
initSocialLinks();
$('descriptionPreview').textContent = buildDescription('Tu descripción aparecerá aquí.');
updateSummary();
