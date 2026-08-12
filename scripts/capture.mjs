#!/usr/bin/env node
/**
 * Screenshots the live page so the race can be replayed afterwards as it was
 * actually seen, not just as the archive can reconstruct it.
 *
 * track.json preserves every position, so the route is recoverable regardless.
 * What it cannot recover is what the page was *showing* at a given moment —
 * which stage it thought he was on, what it said about the plan, whether it
 * was warning about a stale pipeline. That is what these capture.
 *
 *   node scripts/capture.mjs                 one capture, now
 *   node scripts/capture.mjs --loop 600      every 10 minutes until stopped
 *   node scripts/capture.mjs --phone         also capture at 390px
 *
 * Output lands in capture/ — gitignored, because ~120 full-page PNGs would
 * bloat the repo and every commit rebuilds Pages against a build-rate limit.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const URL = process.env.CAPTURE_URL || 'https://davidsdot.com/live.html';
const OUT = 'capture';

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const LOOP = arg('loop', null);
const PHONE = !!arg('phone', false);

/** Sortable UTC stamp, safe as a filename. */
const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';

async function once(browser) {
  const now = new Date();
  const name = stamp(now);
  const shots = [];

  for (const [label, width, full] of PHONE
    ? [['desktop', 1440, true], ['phone', 390, true]]
    : [['desktop', 1440, true]]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 1000 },
      deviceScaleFactor: label === 'phone' ? 2 : 1,
      timezoneId: 'America/Denver',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
      // Let the course files land and the first refresh paint.
      await page.waitForTimeout(4000);
      // JPEG, not PNG. A full-page shot of a map is ~1.7 MB as PNG and about
      // a tenth of that as JPEG, with no legibility lost — and there will be
      // roughly 120 of them across the race.
      const file = `${OUT}/${name}-${label}.jpg`;
      await page.screenshot({ path: file, fullPage: full, type: 'jpeg', quality: 82 });
      shots.push(file);

      if (label === 'desktop') {
        // A sidecar of what the page actually said, so the replay is
        // searchable and not only a pile of images.
        const readouts = await page.evaluate(() => {
          const t = (id) => (document.getElementById(id) || {}).textContent || null;
          const vis = (id) => {
            const el = document.getElementById(id);
            return el && !el.hidden ? el.textContent : null;
          };
          return {
            where: t('where'),
            whereSub: t('where-sub'),
            progress: t('progress'),
            plan: t('plan'),
            planSub: t('plan-sub'),
            elapsed: t('elapsed'),
            fixAge: t('fix-age'),
            fixTime: t('fix-time'),
            position: t('position'),
            alert: vis('alert'),
            health: vis('health'),
            stages: [...document.querySelectorAll('.stage')].map((e) =>
              e.className.includes('is-done') ? 'done' : e.className.includes('is-active') ? 'active' : 'todo'
            ),
            pings: [...document.querySelectorAll('.ping')]
              .map((p) => (p.classList.contains('is-hit') ? '#' : '.'))
              .join(''),
          };
        });
        await writeFile(
          `${OUT}/${name}.json`,
          JSON.stringify({ at: now.toISOString(), url: URL, ...readouts }, null, 2) + '\n'
        );
        const local = now.toLocaleString('en-US', { timeZone: 'America/Denver', hour12: false });
        console.log(`${local} MT  ${readouts.where || '—'}  ${readouts.progress || '—'}  ${readouts.plan || '—'}`);
      }
    } catch (err) {
      console.error(`capture failed: ${err.message}`);
    } finally {
      await ctx.close();
    }
  }
  return shots;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();

  if (!LOOP) {
    await once(browser);
    await browser.close();
    return;
  }

  const every = Number(LOOP) * 1000;
  console.log(`Capturing ${URL} every ${LOOP}s into ${OUT}/. Ctrl-C to stop.`);
  // Runs until killed. Deliberately does not exit on error — a failed capture
  // during a network blip should not end a 58-hour recording.
  for (;;) {
    await once(browser);
    await new Promise((r) => setTimeout(r, every));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
