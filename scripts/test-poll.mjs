#!/usr/bin/env node
/**
 * Runs the poller against the mock feed across every response shape SPOT is
 * known to produce, and every failure mode that matters while nobody is
 * watching. The bar is not "succeeds" — it is "never damages the archive".
 *
 * Usage: node scripts/test-poll.mjs
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TMP = 'tmp/test';
const OUT = `${TMP}/track.json`;
let port = 8850;

const run = (cmd, args, env = {}) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, shell: false });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });

async function withMock(scenario, fn, extra = []) {
  const p = ++port;
  const server = spawn('node', ['scripts/mock-spot.mjs', '--scenario', scenario, '--port', String(p), ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => server.stdout.once('data', r));
  try {
    return await fn(p);
  } finally {
    server.kill();
  }
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const readOut = async () => {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch (e) {
    return { __unparseable: e.message };
  }
};

const poll = (p, env = {}) =>
  run('node', ['scripts/poll.mjs'], {
    SPOT_FEED_ID: 'TESTFEED00000000000000000000000',
    SPOT_API_BASE: `http://localhost:${p}`,
    OUT_PATH: OUT,
    ...env,
  });

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  console.log('\n— documented response shapes —');

  await withMock('normal', async (p) => {
    const r = await poll(p);
    const a = await readOut();
    check('normal: exits 0', r.code === 0, r.err);
    check('normal: archive has 240 points', a.points?.length === 240, `got ${a.points?.length}`);
    check('normal: sorted ascending', a.points?.every((x, i, s) => !i || s[i - 1].t <= x.t));
    check('normal: feed metadata captured', a.feed?.name === 'Mega Epic');
  });

  await rm(OUT, { force: true });
  await withMock('single', async (p) => {
    const r = await poll(p);
    const a = await readOut();
    check('single message returned bare, not as array', r.code === 0 && a.points?.length === 1, `got ${a.points?.length}`);
  });

  await rm(OUT, { force: true });
  await withMock('nodata', async (p) => {
    const r = await poll(p);
    check('empty feed (E-0195) is not treated as failure', r.code === 0, r.err);
    const a = await readOut();
    check('empty feed writes an empty but valid archive', Array.isArray(a.points) && a.points.length === 0);
  });

  await rm(OUT, { force: true });
  await withMock('unpositioned', async (p) => {
    await poll(p);
    const a = await readOut();
    const un = a.points?.filter((x) => !x.positioned) ?? [];
    check('-99999 rows kept but flagged unpositioned', un.length === 2, `got ${un.length}`);
    check('-99999 rows carry null coords', un.every((x) => x.lat === null && x.lon === null));
  });

  console.log('\n— archive integrity under failure —');

  // Seed a known-good archive, then break the feed in each way and assert the
  // archive on disk is untouched. This is the property that actually matters:
  // SPOT drops data after 7 days, so a corrupted file is unrecoverable.
  const seed = {
    feed: { id: 'SEED', name: 'Mega Epic', description: null },
    count: 3,
    points: [
      { id: '1', t: 1000, iso: null, lat: 39.48, lon: -106.03, type: 'TRACK', text: null, battery: 'GOOD', positioned: true },
      { id: '2', t: 2000, iso: null, lat: 39.49, lon: -106.04, type: 'TRACK', text: null, battery: 'GOOD', positioned: true },
      { id: '3', t: 3000, iso: null, lat: 39.5, lon: -106.05, type: 'TRACK', text: null, battery: 'GOOD', positioned: true },
    ],
  };
  const seedText = JSON.stringify(seed, null, 2) + '\n';

  for (const scenario of ['malformed', 'partial', 'ratelimit', 'nodata']) {
    await writeFile(OUT, seedText);
    const r = await withMock(scenario, (p) => poll(p));
    const after = await readFile(OUT, 'utf8');
    const parsed = await readOut();
    const keptAll = parsed.points?.length >= 3 && seed.points.every((s) => parsed.points.some((x) => x.id === s.id));
    check(`${scenario}: archive still parses`, !parsed.__unparseable, parsed.__unparseable);
    check(`${scenario}: no seeded point lost`, !!keptAll, `have ${parsed.points?.length}`);
    if (scenario === 'ratelimit') {
      check('ratelimit: recovers and exits 0', r.code === 0, r.err || 'poller gave up');
    }
    if (scenario === 'partial') {
      check('partial: keeps page-1 progress rather than discarding it', (parsed.points?.length ?? 0) > 3, `have ${parsed.points?.length}`);
    }
  }

  console.log('\n— behaviour —');
  await rm(OUT, { force: true });
  await withMock('normal', async (p) => {
    await poll(p);
    const first = await readFile(OUT, 'utf8');
    const r2 = await poll(p);
    const second = await readFile(OUT, 'utf8');
    check('re-poll is idempotent (byte identical)', first === second);
    check('re-poll reports no change', /No change/.test(r2.out), r2.out);
  });

  await withMock('help', async (p) => {
    await rm(OUT, { force: true });
    await poll(p);
    const a = await readOut();
    check('HELP message preserved in archive', a.points?.some((x) => x.type === 'HELP'));
  });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFailures:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
