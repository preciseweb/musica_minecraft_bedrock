import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const directory = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const configuration = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const securityHeaders = Object.fromEntries(configuration.headers[0].headers.map(({ key, value }) => [key, value]));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm' };
http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(`${directory}${path.sep}`)) throw new Error('Invalid path');
    const data = await readFile(filename);
    response.writeHead(200, {
      'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      ...securityHeaders
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('No encontrado');
  }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://localhost:${port}`));
