#!/usr/bin/env node
/**
 * Serves docs/ locally, for looking at the site without deploying.
 *
 *   npm run serve          ->  http://localhost:8080
 *   npm run serve -- 9000  ->  a different port
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const PORT = Number(process.argv[2] || 8080);
const ROOT = resolve('docs');

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';

  // Resolve inside docs/ and then confirm the result is still inside it,
  // rather than trying to pattern-match traversal out of the request.
  const file = resolve(join(ROOT, path));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`not found: ${path}`);
  }
}).listen(PORT, () => {
  console.log(`\n  Serving docs/ at http://localhost:${PORT}\n`);
  console.log(`  replay    http://localhost:${PORT}/replay.html`);
  console.log(`  tracker   http://localhost:${PORT}/live.html`);
  console.log(`  home      http://localhost:${PORT}/\n`);
  console.log('  Ctrl-C to stop.\n');
});
