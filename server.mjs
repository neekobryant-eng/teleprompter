// Development server: serves this folder at http://localhost:8080 with caching turned off,
// so every reload on the tablet picks up the latest code. No dependencies.
// Run with:  node server.mjs        (or double-click dev.cmd)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(root, path));
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
  console.log(`${res.statusCode} ${req.method} ${path}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${port} is already in use, so a dev server is probably already running.`);
    console.log(`The tablet can keep using http://localhost:${port}. Close the other one first to restart it.`);
    process.exit(1);
  }
  throw err;
});

// Bound to 127.0.0.1 only: reachable from this laptop and, through "adb reverse", the tablet.
server.listen(port, '127.0.0.1', () => {
  console.log(`Teleprompter dev server running at http://localhost:${port}`);
  console.log('Press Ctrl+C to stop.');
});
