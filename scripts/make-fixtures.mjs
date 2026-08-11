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
 * Walks the schedule rather than a constant pace: each stage is ridden across
 * its own gun-to-finish window, and the breaks between them hold position at
 * the stage finish, which is where he actually is — at home, asleep.
 *
 * `lagHours` runs the whole thing late, which is how the page's plan delta and
 * its tolerance for being off-schedule get exercised.
 */
function scheduleMileAt(elapsedH, CFG, spans, lagHours = 0, driftPerHour = 0) {
  // Drift accumulates, which is what actually happens: nobody is uniformly
  // half an hour late, they lose a few minutes an hour and it compounds.
  const t = elapsedH - (lagHours + driftPerHour * elapsedH);
  if (t <= 0) return 0;
  let last = 0;
  for (const s of CFG.stages) {
    const span = spans.find((x) => x.stage === s.n);
    if (!span) continue;
    const a = s.startOffsetHours;
    const b = a + s.durationHours;
    if (t < a) return last; // in the break before this stage
    if (t <= b) return span.startMile + ((t - a) / (b - a)) * (span.endMile - span.startMile);
    last = span.endMile;
  }
  return last;
}

function buildFixes(sampleAt, { hours, gapAtHour = null, gapMinutes = 0, endAgoMinutes = 8, lagHours = 0, driftPerHour = 0, CFG, spans }) {
  const points = [];
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
    const mile = scheduleMileAt(hourIn, CFG, spans, lagHours, driftPerHour);

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

  // The page's config is the single source of the schedule, so the fixtures
  // read it rather than keeping a second copy that can drift.
  const cfgSrc = await readFile('docs/config.js', 'utf8');
  const win = {};
  new Function('window', cfgSrc)(win);
  const CFG = win.RACE_CONFIG;
  const spans = idx.stageSpans;
  const ride = (o) => buildFixes(sampleAt, { CFG, spans, ...o });

  const write = async (name, points, now, stOpts) => {
    await writeFile(`${OUT}/${name}.track.json`, JSON.stringify(archive(points), null, 2) + '\n');
    await writeFile(`${OUT}/${name}.status.json`, JSON.stringify(status(points, now, stOpts), null, 2) + '\n');
    await writeFile(`${OUT}/${name}.meta.json`, JSON.stringify({ now }, null, 2) + '\n');
    const at = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`${name.padEnd(14)} ${String(points.length).padStart(4)} points   clock ${at}Z`);
  };

  // 1. Nothing has happened yet. Clock sits an hour before the start.
  await write('pre-start', [], START_MS - 3600000);

  // 1b. What production actually looks like the day before: one OK check-in
  //     from Breckenridge, hours before the gun. Snapping this to the course
  //     would report a stage and a mileage that mean nothing yet.
  const checkin = [
    {
      id: '2482689660',
      t: Math.floor((START_MS - 11 * 3600000) / 1000),
      iso: null,
      lat: 39.48695,
      lon: -106.03648,
      type: 'OK',
      text: 'Just checking in to say that I am OK and all is well',
      battery: 'LOW',
      positioned: true,
    },
  ];
  await write('pre-start-checkin', checkin, START_MS - 10 * 3600000);

  // 2. Mid-race: through the first night, onto stage 3.
  const mid = ride({ hours: 22, lagHours: 0.8 });
  await write('mid-race', mid.points, mid.now);

  // 3. Ninety minutes of nothing in the middle — trees, canyon, or a device
  //    face-down in a pack.
  const gap = ride({ hours: 22, gapAtHour: 14, gapMinutes: 90, lagHours: 0.8 });
  await write('gap', gap.points, gap.now);

  // 4. Last fix 40 minutes ago. The dangerous one: is he stopped, or is the
  //    pipeline dead?
  const stale = ride({ hours: 22, endAgoMinutes: 40, lagHours: 0.8 });
  await write('stale', stale.points, stale.now);

  // 5. HELP, un-cancelled.
  const help = ride({ hours: 22, lagHours: 0.8 });
  const last = help.points[help.points.length - 1];
  help.points.push({ ...last, id: '9999999', t: last.t + 120, type: 'HELP', text: 'Help. Send help.' });
  await write('help', help.points, help.now);

  // 6. The poller has stopped but the last fix is only 20 minutes old, so a
  //    page watching only fix age would look calm and be wrong.
  const dead = ride({ hours: 22, endAgoMinutes: 20, lagHours: 0.8 });
  await write('poller-dead', dead.points, dead.now, {
    agoMinutes: 75,
    ok: false,
    error: 'HTTP 503 Service Unavailable',
  });

  // 7. Parked mid-sleep. Fixes keep arriving from the same spot, which is the
  //    case most easily mistaken for a fault.
  const stopped = ride({ hours: 16.5, lagHours: 0.5 });
  await write('stopped', stopped.points, stopped.now);

  // 8. The whole race, for the replay simulator. Drifts steadily later, the
  //     way a long effort actually goes, and loses the tracker for a while
  //     under the trees on Aqueduct.
  const full = ride({ hours: 57.5, lagHours: 0.2, driftPerHour: 0.012, gapAtHour: 31, gapMinutes: 75 });
  await write('full-race', full.points, full.now);

  // 9. Deep night on stage 4, for judging legibility at 4am.
  const night = ride({ hours: 31, lagHours: 1.2 });
  await write('night', night.points, night.now);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
