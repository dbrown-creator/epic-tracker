#!/usr/bin/env node
/**
 * Synthetic track data for looking at the page in states that only occur once,
 * at 3am, when nobody can reproduce them.
 *
 * Fixes are walked along the real course line so stage detection, climb naming
 * and along-course progress are genuinely exercised rather than stubbed.
 *
 * Output goes to fixtures/ and never to docs/data/. Nothing in here is real
 * history and none of it should ever be committed as such.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = 'fixtures';
const IDX = 'docs/courses/course-index.json';

// The configured start, as a UTC instant. 09:00 MDT on 12 August 2026.
const START_MS = Date.parse('2026-08-12T15:00:00Z');
const PING_MIN = 10;

const jitter = (seed) => (Math.sin(seed * 12.9898) * 43758.5453) % 1; // deterministic

/** Position on the course at a given mileage. */
function makeSampler(idx) {
  const { lon, lat, cumMiles } = idx;
  return (mile) => {
    const m = Math.max(0, Math.min(mile, cumMiles[cumMiles.length - 1]));
    let lo = 0;
    let hi = cumMiles.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumMiles[mid] <= m) lo = mid;
      else hi = mid;
    }
    const span = cumMiles[hi] - cumMiles[lo] || 1;
    const t = (m - cumMiles[lo]) / span;
    return [lat[lo] + t * (lat[hi] - lat[lo]), lon[lo] + t * (lon[hi] - lon[lo])];
  };
}

/**
 * Walks the course from mile 0, at a pace that slows on climbs and stops for
 * the two planned sleeps, emitting a fix every ten minutes.
 */
function buildFixes(sampleAt, { hours, gapAtHour = null, gapMinutes = 0, endAgoMinutes = 8 }) {
  const points = [];
  let mile = 0;
  let id = 4000000;

  const totalSlots = Math.floor((hours * 60) / PING_MIN);
  // Anchored to race time, not wall time: the newest fix sits `hours` into the
  // ride and the harness freezes the browser clock `endAgoMinutes` later. That
  // way elapsed, the ping meter and staleness are all exercised for real and
  // the screenshots are reproducible rather than depending on when they ran.
  const firstMs = START_MS;
  const lastMs = firstMs + totalSlots * PING_MIN * 60000;

  for (let i = 0; i <= totalSlots; i++) {
    const tMs = firstMs + i * PING_MIN * 60000;
    const hourIn = (tMs - firstMs) / 3600000;

    // A rest between stage 2 and 3, and again between 4 and 5.
    const resting = (hourIn > 12.5 && hourIn < 17.5) || (hourIn > 34 && hourIn < 39);
    const mph = resting ? 0 : 5.4 + jitter(i) * 1.6;
    mile += (mph * PING_MIN) / 60;

    if (gapAtHour !== null && hourIn > gapAtHour && hourIn < gapAtHour + gapMinutes / 60) continue;

    if (tMs > lastMs) break;
    const [lat, lon] = sampleAt(mile);
    points.push({
      id: String(id++),
      t: Math.floor(tMs / 1000),
      iso: new Date(tMs).toISOString().replace('.000Z', '+0000'),
      // A few metres of scatter, as a real fix has.
      lat: Number((lat + jitter(i * 3) * 0.00025).toFixed(5)),
      lon: Number((lon + jitter(i * 7) * 0.00025).toFixed(5)),
      type: 'TRACK',
      text: null,
      battery: 'GOOD',
      positioned: true,
    });
  }
  // `now` is what the browser clock gets frozen to when shooting.
  return { points, now: lastMs + endAgoMinutes * 60000 };
}

const archive = (points) => ({
  feed: { name: 'Brk Epic', description: 'Brk Epic', status: 'ACTIVE' },
  count: points.length,
  points,
});

const status = (points, now, { agoMinutes = 1, ok = true, error = null } = {}) => ({
  polledAt: new Date(now - agoMinutes * 60000).toISOString(),
  ok,
  error,
  points: points.length,
  lastFixAt: points.length ? points[points.length - 1].t : null,
  fetched: points.length ? 1 : 0,
  intervalMinutes: PING_MIN,
});

async function main() {
  const idx = JSON.parse(await readFile(IDX, 'utf8'));
  const sampleAt = makeSampler(idx);
  await mkdir(OUT, { recursive: true });

  const write = async (name, points, now, stOpts) => {
    await writeFile(`${OUT}/${name}.track.json`, JSON.stringify(archive(points), null, 2) + '\n');
    await writeFile(`${OUT}/${name}.status.json`, JSON.stringify(status(points, now, stOpts), null, 2) + '\n');
    await writeFile(`${OUT}/${name}.meta.json`, JSON.stringify({ now }, null, 2) + '\n');
    const at = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`${name.padEnd(14)} ${String(points.length).padStart(4)} points   clock ${at}Z`);
  };

  // 1. Nothing has happened yet. Clock sits an hour before the start.
  await write('pre-start', [], START_MS - 3600000);

  // 2. Mid-race: through the first night, onto stage 3.
  const mid = buildFixes(sampleAt, { hours: 22 });
  await write('mid-race', mid.points, mid.now);

  // 3. Ninety minutes of nothing in the middle — trees, canyon, or a device
  //    face-down in a pack.
  const gap = buildFixes(sampleAt, { hours: 22, gapAtHour: 14, gapMinutes: 90 });
  await write('gap', gap.points, gap.now);

  // 4. Last fix 40 minutes ago. The dangerous one: is he stopped, or is the
  //    pipeline dead?
  const stale = buildFixes(sampleAt, { hours: 22, endAgoMinutes: 40 });
  await write('stale', stale.points, stale.now);

  // 5. HELP, un-cancelled.
  const help = buildFixes(sampleAt, { hours: 22 });
  const last = help.points[help.points.length - 1];
  help.points.push({ ...last, id: '9999999', t: last.t + 120, type: 'HELP', text: 'Help. Send help.' });
  await write('help', help.points, help.now);

  // 6. The poller has stopped but the last fix is only 20 minutes old, so a
  //    page watching only fix age would look calm and be wrong.
  const dead = buildFixes(sampleAt, { hours: 22, endAgoMinutes: 20 });
  await write('poller-dead', dead.points, dead.now, {
    agoMinutes: 75,
    ok: false,
    error: 'HTTP 503 Service Unavailable',
  });

  // 7. Deep night on stage 4, for judging legibility at 4am.
  const night = buildFixes(sampleAt, { hours: 31 });
  await write('night', night.points, night.now);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
