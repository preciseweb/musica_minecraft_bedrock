import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTION, DISCS, MAX_AUDIO_BYTES, MAX_ICON_BYTES, buildDescription,
  buildPackMetadata, discTexturePath, downloadFilename, validateAudio, validateIcon,
} from '../pack.js';

test('both manifest descriptions preserve the user text and append the exact credits', () => {
  const description = 'Mis canciones favoritas\nPara compartir con mis amigos';
  const expected = `${description}\nEcho por Preciseweb\nlink para crear tu mod de musica: https://musica-minecraft-bedrock.vercel.app/`;
  let sequence = 0;
  const first = buildPackMetadata('  Mi mundo  ', description, ['cat'], () => `uuid-${++sequence}`);
  const second = buildPackMetadata('  Mi mundo  ', description, ['cat'], () => `uuid-${++sequence}`);
  assert.equal(first.manifest.header.description, expected);
  assert.equal(first.manifest.modules[0].description, expected);
  assert.equal(second.manifest.header.description, expected);
  assert.equal(first.manifest.header.name, 'Mi mundo');
  assert.notEqual(first.manifest.header.uuid, first.manifest.modules[0].uuid);
  assert.notEqual(first.manifest.header.uuid, second.manifest.header.uuid);
  assert.equal(description, 'Mis canciones favoritas\nPara compartir con mis amigos');
  assert.equal(buildDescription('  Música\nNueva aventura  '), `Música\nNueva aventura\n${ATTRIBUTION}`);
});

test('downloads have a safe, bounded .mcpack filename', () => {
  assert.equal(downloadFilename('  Mi pack / \\ : ? * < > | "  '), 'Mi_pack_.mcpack');
  assert.equal(downloadFilename('...'), 'Mi_musica.mcpack');
  assert.equal(downloadFilename('  '), 'Mi_musica.mcpack');
  const name = downloadFilename(`.${'x'.repeat(100)}\u0000\u001f\u007f`);
  assert.equal(name, `${'x'.repeat(80)}.mcpack`);
  assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f\u007f]/);
});

test('audio and cover validation rejects empty, oversized and incompatible files', () => {
  const file = (name, type, size = 12) => ({ name, type, size });
  assert.equal(validateAudio(file('song.WAV', '')), '');
  assert.equal(validateAudio(file('recording', 'audio/ogg')), '');
  assert.equal(validateAudio(file('video.mp4', 'video/mp4')), '');
  assert.match(validateAudio(file('song.wav', 'audio/wav', 0)), /vacío/);
  assert.equal(validateAudio(file('song.wav', 'audio/wav', 512 * 1024 * 1024)), '');
  assert.equal(validateAudio(file('song.wav', 'audio/wav', MAX_AUDIO_BYTES)), '');
  assert.match(validateAudio(file('song.wav', 'audio/wav', 2 * 1024 * 1024 * 1024)), /2 GB/);
  assert.match(validateAudio(file('document.pdf', 'application/pdf')), /audio compatible/);
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(validateIcon(file('cover', type)), '');
  }
  assert.match(validateIcon(file('cover.png', 'image/png', 0)), /vacía/);
  assert.match(validateIcon(file('cover.jpg', 'image/jpeg', MAX_ICON_BYTES + 1)), /10 MB/);
  assert.match(validateIcon(file('cover.svg', 'image/svg+xml')), /PNG, JPG o WebP/);
});

test('partial packs override only the chosen records and stream each sound', () => {
  const { soundDefinitions } = buildPackMetadata('Mi pack', 'Música', ['cat', 'creator_music_box'], () => 'test-uuid');
  assert.deepEqual(Object.keys(soundDefinitions.sound_definitions), ['record.cat', 'record.creator_music_box']);
  assert.deepEqual(soundDefinitions.sound_definitions['record.cat'], {
    category: 'record',
    max_distance: 64,
    sounds: [{ name: 'sounds/music/game/records/cat', stream: true }],
  });
  assert.equal(soundDefinitions.sound_definitions['record.creator_music_box'].sounds[0].stream, true);
  assert.throws(() => buildPackMetadata('Mi pack', 'Música', ['unknown'], () => 'test-uuid'), /Disco desconocido/);
  assert.equal(new Set(DISCS).size, DISCS.length);
});

test('minimum Minecraft version follows the most recent selected record', () => {
  const minimum = (discs) => buildPackMetadata('Mi pack', 'Música', discs, () => 'test-uuid').manifest.header.min_engine_version;
  assert.deepEqual(minimum(['11', 'cat']), [1, 16, 0]);
  assert.deepEqual(minimum(['cat', 'relic']), [1, 20, 0]);
  assert.deepEqual(minimum(['tears', 'lava_chicken']), [1, 21, 93]);
  assert.deepEqual(minimum(['bounce', 'cat', 'lava_chicken']), [1, 26, 30]);
});

test('all 22 record textures override their actual Bedrock item paths', () => {
  const expectedPaths = {
    '11': 'record_11', '13': 'record_13', blocks: 'record_blocks', cat: 'record_cat',
    chirp: 'record_chirp', far: 'record_far', mall: 'record_mall', mellohi: 'record_mellohi',
    stal: 'record_stal', strad: 'record_strad', wait: 'record_wait', ward: 'record_ward',
    pigstep: 'record_pigstep', otherside: 'record_otherside', '5': 'record_5',
    relic: 'music_disc_relic', precipice: 'music_disc_precipice', creator: 'music_disc_creator',
    creator_music_box: 'music_disc_creator_music_box', tears: 'music_disc_tears',
    bounce: 'music_disc_bounce', lava_chicken: 'music_disc_lava_chicken',
  };
  assert.equal(DISCS.length, 22);
  assert.deepEqual([...DISCS].sort(), Object.keys(expectedPaths).sort());
  for (const [disc, filename] of Object.entries(expectedPaths)) {
    assert.equal(discTexturePath(disc), `textures/items/${filename}.png`);
  }
  assert.throws(() => discTexturePath('unknown'), /Disco desconocido/);
});
