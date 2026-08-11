#!/usr/bin/env node
/**
 * Renders the page against each fixture at desktop and phone widths.
 *
 * Serves a copy of docs/ from tmp/preview with the fixture swapped in, so
 * docs/data/track.json — the real archive — is never touched.
 *
 *   node scripts/shoot.mjs [--only mid-race] [--night]
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, cp, writeFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PREVIEW = 'tmp/preview';
const SHOTS = 'shots';
const PORT = 8099;

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const only = arg('only');

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
};

const VIEWS = [
  { name: 'desktop', width: 1440, height: 1200, dpr: 1 },
  { name: 'phone', width: 390, height: 844, dpr: 2 },
];

async function main() {
  await mkdir(SHOTS, { recursive: true });
  await mkdir(PREVIEW, { recursive: true });
  await cp('docs', PREVIEW, { recursive: true });

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = join(PREVIEW, path === '/' ? 'live.html' : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, r));

  const fixtures = [...new Set((await readdir('fixtures')).map((f) => f.split('.')[0]))]
    .filter((f) => !only || f === only)
    .sort();

  const browser = await chromium.launch();

  for (const fx of fixtures) {
    await cp(`fixtures/${fx}.track.json`, `${PREVIEW}/data/track.json`);
    await cp(`fixtures/${fx}.status.json`, `${PREVIEW}/data/status.json`);
    const meta = JSON.parse(await readFile(`fixtures/${fx}.meta.json`, 'utf8'));

    for (const v of VIEWS) {
      const ctx = await browser.newContext({
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: v.dpr,
        // Kept honest about which failures are the page's: tile requests go
        // nowhere in this harness, so the basemap is deliberately blank.
        offline: false,
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

      // Freeze the browser clock at the fixture's intended moment so elapsed,
      // staleness and the ping meter read correctly and the shots are
      // reproducible rather than depending on when they were taken.
      await page.clock.setFixedTime(new Date(meta.now));

      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
      // Give the course fetches and first refresh a moment to land.
      await page.waitForTimeout(2500);

      const shot = `${SHOTS}/${fx}-${v.name}.png`;
      await page.screenshot({ path: shot, fullPage: true });

      const readouts = await page.evaluate(() => {
        const t = (id) => (document.getElementById(id) || {}).textContent || '';
        const vis = (id) => {
          const el = document.getElementById(id);
          return el && !el.hidden ? el.textContent : null;
        };
        return {
          where: t('where'),
          whereSub: t('where-sub'),
          plan: t('plan'),
          planSub: t('plan-sub'),
          fixTime: t('fix-time'),
          progress: t('progress'),
          progressSub: t('progress-sub'),
          fixAge: t('fix-age'),
          crew: t('crew'),
          crewSub: t('crew-sub'),
          elapsed: t('elapsed'),
          alert: vis('alert'),
          health: vis('health'),
          pings: [...document.querySelectorAll('.ping')].map((p) =>
            p.classList.contains('is-hit') ? '#' : '.'
          ).join(''),
        };
      });

      console.log(`\n${fx} / ${v.name}  -> ${shot}`);
      console.log(`  where     ${readouts.where} | ${readouts.whereSub}`);
      console.log(`  progress  ${readouts.progress} ${readouts.progressSub}`);
      console.log(`  plan      ${readouts.plan} | ${readouts.planSub}`);
      console.log(`  last fix  ${readouts.fixAge}   elapsed ${readouts.elapsed}   ${readouts.fixTime}`);
      console.log(`  crew      ${readouts.crew} | ${readouts.crewSub}`);
      console.log(`  pings     [${readouts.pings}]`);
      if (readouts.alert) console.log(`  ALERT     ${readouts.alert}`);
      if (readouts.health) console.log(`  HEALTH    ${readouts.health}`);
      if (errors.length) console.log(`  JS ERRORS ${errors.slice(0, 3).join(' | ')}`);

      await ctx.close();
    }
  }

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
