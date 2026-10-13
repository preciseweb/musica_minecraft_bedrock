import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'vendor'), { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js', 'pack.js', 'converter.js', 'social-links.js']) {
  await cp(path.join(root, file), path.join(output, file));
}
await cp(path.join(root, 'node_modules/@ffmpeg/ffmpeg/dist/esm'), path.join(output, 'vendor/ffmpeg-0.12.15'), { recursive: true });
await cp(path.join(root, 'node_modules/@ffmpeg/core/dist/esm'), path.join(output, 'vendor/core-0.12.10'), { recursive: true });
await cp(path.join(root, 'node_modules/jszip/dist/jszip.min.js'), path.join(output, 'vendor/jszip-3.10.1.min.js'));
console.log('Sitio preparado en dist/.');
