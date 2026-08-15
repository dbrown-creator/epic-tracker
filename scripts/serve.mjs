#!/usr/bin/env node
/**
 * Serves docs/ locally, for looking at the site without deploying.
 *
 *   npm run serve        ->  http://localhost:8080
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2] || 8080);
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.geojson': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  // Keep the server inside docs/ whatever the request asks for.
  const rel = normalize(path === '/' ? 'index.html' : path).replace(/^([./\\]*\.\.[/\\])+/, '');
  try {
    const file = join('docs', rel);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`\n  Serving docs/ at http://localhost:${PORT}\n`);
  console.log(`  replay    http://localhost:${PORT}/replay.html`);
  console.log(`  tracker   http://localhost:${PORT}/live.html`);
  console.log(`  home      http://localhost:${PORT}/\n`);
  console.log('  Ctrl-C to stop.\n');
});
