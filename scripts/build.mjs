import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'vendor'), { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js', 'pack.js', 'converter.js', 'social-links.js', 'artwork.js']) {
  await cp(path.join(root, file), path.join(output, file));
}
await cp(path.join(root, 'node_modules/@ffmpeg/ffmpeg/dist/esm'), path.join(output, 'vendor/ffmpeg-0.12.15'), { recursive: true });
await cp(path.join(root, 'node_modules/@ffmpeg/core/dist/esm'), path.join(output, 'vendor/core-0.12.10'), { recursive: true });
await cp(path.join(root, 'node_modules/jszip/dist/jszip.min.js'), path.join(output, 'vendor/jszip-3.10.1.min.js'));
await build({
  stdin: { contents: "export { parseBlob, selectCover } from 'music-metadata';", resolveDir: root, sourcefile: 'metadata-entry.js' },
  outdir: path.join(output, 'vendor/metadata-12.2.0'),
  entryNames: 'index',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  minify: true
});
console.log('Sitio preparado en dist/.');
