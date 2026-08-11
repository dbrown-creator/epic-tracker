#!/usr/bin/env node
/**
 * Replays a whole 57-hour race through the real page in under a minute.
 *
 * The page is not modified. A copy is served from tmp/sim with one script
 * injected between config.js and app.js that (a) speeds the clock up and
 * (b) makes the page refresh often enough to keep up. Everything else — the
 * snapping, the stage detection, the plan delta, the ping meter — runs
 * exactly as it will on race day, which is the point: this is for catching
 * bugs in that logic, not for looking at a mock.
 *
 *   node scripts/simulate.mjs                 # 57 h in 45 s, then open the URL
 *   node scripts/simulate.mjs --seconds 90    # slower, easier to read
 *   node scripts/simulate.mjs --from 18       # start partway in, at hour 18
 *   node scripts/simulate.mjs --check         # no browser: assert as it runs
 *
 * Scripted faults, as race-time hours:
 *   --outage 31,1.5    poller stops for 1.5 h from hour 31
 *   --help 40          a HELP message at hour 40
 */

import { createServer } from 'node:http';
import { readFile, cp, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';

const SIM = 'tmp/sim';
const FIXTURE = 'fixtures/full-race.track.json';
const START_MS = Date.parse('2026-08-12T15:00:00Z');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : i > -1
      ? true
      : d;
};

const WALL_SECONDS = Number(arg('seconds', 45));
const FROM_HOUR = Number(arg('from', -1)); // an hour before the gun by default
const PORT = Number(arg('port', 8099));
const CHECK = !!arg('check', false);
const RACE_HOURS = Number(arg('hours', 58));
const REPEAT = !!arg('repeat', false);

const outage = String(arg('outage', '') || '')
  .split(',')
  .map(Number);
const OUTAGE_AT = outage[0] || null;
const OUTAGE_FOR = outage[1] || 1;
const HELP_AT = arg('help', null) ? Number(arg('help')) : null;

const SPEED = ((RACE_HOURS - FROM_HOUR) * 3600) / WALL_SECONDS;

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
};

/** Injected between config.js and app.js. Never ships. */
function clockShim(speed, repeat, cycleMs) {
  // SIM0 is stamped per request with the server's current simulated time, so
  // the page inherits the clock rather than starting its own. Getting this
  // wrong desynchronises the browser from the data by however long the browser
  // took to launch, multiplied by the speed factor — hours of race time.
  return `<script>
(function () {
  var REAL0 = Date.now(), SIM0 = __SIM0__, SPEED = ${speed};
  var RealDate = Date;
  var nowSim = function () { return Math.round(SIM0 + (RealDate.now() - REAL0) * SPEED); };
  function FakeDate(a, b, c, d, e, f, g) {
    if (arguments.length === 0) return new RealDate(nowSim());
    if (arguments.length === 1) return new RealDate(a);
    return new RealDate(a, b, c, d, e, f, g);
  }
  FakeDate.now = nowSim;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  window.Date = FakeDate;
  // The page re-reads track.json on a real-time interval, so it has to poll
  // far more often to keep up with a clock running ${Math.round(speed)}x.
  if (window.RACE_CONFIG) window.RACE_CONFIG.refreshSeconds = 0.25;
  window.__SIM = { now: nowSim, speed: SPEED, start: SIM0 };
  // Reload at the end of a cycle so the page picks up a fresh SIM0 and the
  // replay starts over in sync with the server.
  if (${repeat}) setTimeout(function () { location.reload(); }, ${cycleMs});
})();
</script>
`;
}

async function main() {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const allPoints = fixture.points;

  await rm(SIM, { recursive: true, force: true });
  await mkdir(SIM, { recursive: true });
  await cp('docs', SIM, { recursive: true });

  // Inject the shim into the copy only. Kept as a template so SIM0 can be
  // stamped at request time.
  const rawHtml = await readFile(join(SIM, 'live.html'), 'utf8');
  const htmlTemplate = rawHtml.replace(
    '<script src="app.js"></script>',
    clockShim(SPEED, REPEAT, (WALL_SECONDS + 5) * 1000) + '<script src="app.js"></script>'
  );

  const simStart = START_MS + FROM_HOUR * 3600000;
  const realStart = Date.now();
  // With --repeat the replay cycles, holding on the finish for a few seconds
  // so the end state is readable before it starts over.
  const CYCLE_MS = (WALL_SECONDS + 5) * 1000;
  const simNow = () => {
    let e = Date.now() - realStart;
    if (REPEAT) e = e % CYCLE_MS;
    return simStart + Math.min(e, WALL_SECONDS * 1000) * SPEED;
  };
  const raceHour = () => (simNow() - START_MS) / 3600000;

  // Fixed at the first fix past the HELP hour, so it has one id, one time and
  // one position for the whole replay.
  const helpSrc =
    HELP_AT === null ? null : allPoints.find((p) => (p.t * 1000 - START_MS) / 3600000 >= HELP_AT);
  const helpPoint = helpSrc
    ? { ...helpSrc, id: 'sim-help', t: helpSrc.t + 60, type: 'HELP', text: 'Help. Send help.' }
    : null;

  const inOutage = () => OUTAGE_AT !== null && raceHour() >= OUTAGE_AT && raceHour() < OUTAGE_AT + OUTAGE_FOR;

  const visible = () => {
    const cutoff = simNow();
    const pts = allPoints.filter((p) => p.t * 1000 <= cutoff);
    // A HELP is sent from one place at one time. Anchoring it to whatever the
    // newest fix happens to be makes it a point that moves under a fixed id,
    // which is not a thing the real feed can produce.
    if (HELP_AT !== null && raceHour() >= HELP_AT && helpPoint) {
      // In time order. The poller sorts the archive by timestamp, so appending
      // an older HELP to the end would make the page treat a ten-hour-old
      // point as the current position — an artefact the real feed cannot
      // produce, and it masks whatever the page actually does with a HELP.
      pts.push(helpPoint);
      pts.sort((a, b) => a.t - b.t);
    }
    return pts;
  };

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const send = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };

    if (path === '/data/track.json') {
      const pts = visible();
      return send({ feed: fixture.feed, count: pts.length, points: pts });
    }
    if (path === '/data/status.json') {
      const pts = visible();
      // During an outage the heartbeat freezes, which is exactly what a dead
      // Action looks like: fixes stop arriving and nothing says why.
      const polled = inOutage() ? simNow() - OUTAGE_FOR * 3600000 : simNow();
      return send({
        polledAt: new Date(polled).toISOString(),
        ok: !inOutage(),
        error: inOutage() ? 'HTTP 503 Service Unavailable' : null,
        points: pts.length,
        lastFixAt: pts.length ? pts[pts.length - 1].t : null,
        fetched: 1,
        intervalMinutes: 10,
      });
    }

    if (path === '/' || path === '/live.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end(htmlTemplate.replace('__SIM0__', String(Math.round(simNow()))));
    }

    try {
      const file = join(SIM, path);
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  await new Promise((r) => server.listen(PORT, r));

  const hhmm = (h) => `${Math.floor(h)}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  console.log(`\nReplaying ${RACE_HOURS - FROM_HOUR}h of race in ${WALL_SECONDS}s  (${Math.round(SPEED)}x)`);
  if (OUTAGE_AT) console.log(`  poller outage at race hour ${OUTAGE_AT} for ${OUTAGE_FOR}h`);
  if (HELP_AT !== null) console.log(`  HELP at race hour ${HELP_AT}`);
  console.log(`\n  http://localhost:${PORT}/\n`);

  if (!CHECK) {
    console.log('Open that URL and watch. Ctrl-C to stop.\n');
    // Hold the server open a little past the end so the finish is visible.
    setTimeout(() => process.exit(0), (WALL_SECONDS + 20) * 1000);
    return;
  }

  const { runChecks } = await import('./simulate-check.mjs');
  await runChecks({ port: PORT, wallSeconds: WALL_SECONDS, raceHour, hhmm });
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
