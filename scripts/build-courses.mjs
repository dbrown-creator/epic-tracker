#!/usr/bin/env node
/**
 * Turns the official Breck Epic 2026 CalTopo export into something a phone on
 * trailhead LTE can actually load.
 *
 * The source is 4.7 MB across 58 features. This emits per-stage GeoJSON, a
 * markers file, and a course index used for snapping the live position to the
 * route. Deterministic and idempotent: same input, byte-identical output.
 *
 *   node scripts/build-courses.mjs [--tolerance 0.00006] [--report]
 *
 * Do not hand-edit anything in docs/courses/ — it all comes from here.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SRC = 'routes/breck-epic-2026.json';
const OUT_DIR = 'docs/courses';
const PRECISION = 5; // ~1.1 m at this latitude. Below GPS noise.

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const TOLERANCE = arg('tolerance', 0.00006);

/* ---------- geometry ---------- */

const R_MILES = 3958.7613;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in miles between [lon,lat] pairs. */
function distMiles(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(a[0] - b[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(s));
}

function lineMiles(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += distMiles(coords[i - 1], coords[i]);
  return m;
}

/** Perpendicular distance from p to segment a-b, in degrees. */
function perpDist(p, a, b) {
  // Scale longitude so a degree of each axis is roughly comparable at 39N,
  // otherwise simplification is far more aggressive east-west than north-south.
  const k = Math.cos(toRad(39.5));
  const px = p[0] * k, py = p[1];
  const ax = a[0] * k, ay = a[1];
  const bx = b[0] * k, by = b[1];
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Douglas-Peucker, iterative so 80k points cannot blow the stack.
 * Returns the indices of surviving vertices rather than the vertices
 * themselves, so callers can carry per-vertex data from the full-resolution
 * line — distance in particular, which simplification would otherwise eat.
 */
function simplifyIndices(coords, tolerance) {
  if (coords.length < 3) return coords.map((_, i) => i);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;

  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let worst = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(coords[i], coords[lo], coords[hi]);
      if (d > worst) {
        worst = d;
        idx = i;
      }
    }
    if (idx > -1 && worst > tolerance) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(i);
  return out;
}

const simplify = (coords, tolerance) => simplifyIndices(coords, tolerance).map((i) => coords[i]);

/** Cumulative miles at every vertex of a full-resolution line. */
function cumulative(coords) {
  const out = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + distMiles(coords[i - 1], coords[i]);
  return out;
}

const round = (n) => Number(n.toFixed(PRECISION));
/** Drop to [lon,lat] at fixed precision; carry elevation only where present. */
const trim = (c) => (c.length > 2 && Number.isFinite(c[2]) ? [round(c[0]), round(c[1]), Math.round(c[2])] : [round(c[0]), round(c[1])]);

/* ---------- source parsing ---------- */

const STAGE_ORDER = [
  [1, 'PENNSYLVANIA CREEK', 'Pennsylvania Creek'],
  [2, 'CO TRAIL', 'Colorado Trail'],
  [3, 'GUYOT', 'Mount Guyot'],
  [4, 'AQUEDUCT', 'Aqueduct'],
  [5, 'WHEELER', 'Wheeler'],
  [6, 'GOLD DUST', 'Gold Dust'],
];

/**
 * Markers sort into four kinds and they are not equally useful. Aid stations
 * are excluded entirely: this is ridden as an individual time trial with no
 * access to them, and showing one he cannot use is worse than showing nothing.
 */
function classifyMarker(title) {
  const t = title.toUpperCase();
  if (/\bAID\b/.test(t)) return 'aid';
  if (/WATER/.test(t)) return 'water';
  if (/X-?ING|CROSSING|VEHICLE|CARS|\bROAD\b|\bGATE\b|INTERSECTION/.test(t)) return 'crossing';
  return 'landmark';
}

const isClimb = (title) => /CLIMB|HILL|PASS|GULCH/i.test(title);

async function main() {
  if (!existsSync(SRC)) {
    console.error(`Missing ${SRC}`);
    process.exit(1);
  }

  const srcBytes = (await stat(SRC)).size;
  const src = JSON.parse(await readFile(SRC, 'utf8'));
  const feats = src.features;

  const folders = new Map();
  for (const f of feats) {
    if (f.properties?.class === 'Folder') folders.set(f.id, f.properties.title || '');
  }
  const folderOf = (f) => folders.get(f.properties?.folderId) ?? '';

  await mkdir(OUT_DIR, { recursive: true });
  const written = [];
  const write = async (name, obj) => {
    const text = JSON.stringify(obj) + '\n';
    await writeFile(`${OUT_DIR}/${name}`, text);
    written.push({ name, bytes: Buffer.byteLength(text) });
    return text;
  };

  /* ---- stage lines ---- */

  const lines = feats.filter((f) => f.geometry?.type === 'LineString');
  const stages = [];
  const report = [];

  for (const [n, folderKey, name] of STAGE_ORDER) {
    // Match on folder title, not feature title — stage 1's line is called
    // "STG 1" while its folder is "STAGE 1 - PENNSYLVANIA CREEK".
    const feat = lines.find((f) => folderOf(f).includes(folderKey));
    if (!feat) {
      console.warn(`No line found for stage ${n} (${folderKey})`);
      continue;
    }
    const raw = feat.geometry.coordinates;
    const simplified = simplify(raw, TOLERANCE).map(trim);
    const hasElevation = simplified.some((c) => c.length > 2);

    const geo = {
      type: 'Feature',
      properties: { stage: n, name, miles: Number(lineMiles(raw).toFixed(2)), hasElevation },
      geometry: { type: 'LineString', coordinates: simplified },
    };
    const text = await write(`stage-${n}.geojson`, geo);

    report.push({
      stage: n,
      name,
      rawPoints: raw.length,
      keptPoints: simplified.length,
      rawMiles: lineMiles(raw),
      keptMiles: lineMiles(simplified),
      bytes: Buffer.byteLength(text),
      hasElevation,
    });
    stages.push({ n, name, coords: simplified, miles: lineMiles(raw), hasElevation });
  }

  /* ---- the master line ---- */

  const megaFeat = lines.find((f) => folderOf(f).includes('MEGA EPIC'));
  const megaRaw = megaFeat.geometry.coordinates;
  const megaKeep = simplifyIndices(megaRaw, TOLERANCE);
  const megaSimple = megaKeep.map((i) => trim(megaRaw[i]));

  // Distance is measured on the full-resolution line and carried onto the
  // vertices that survive. Measuring the simplified line instead loses ~1.4%
  // — three miles over the course — because simplification cuts switchbacks,
  // which is exactly the error the page already warns about for raw fixes.
  const megaCum = cumulative(megaRaw);

  await write('mega.geojson', {
    type: 'Feature',
    properties: { name: 'MEGA EPIC', miles: Number(lineMiles(megaRaw).toFixed(2)) },
    geometry: { type: 'LineString', coordinates: megaSimple },
  });

  /* ---- course index: cumulative miles + stage per vertex ---- */

  // Every stage starts and finishes in Breckenridge and several share trail,
  // so "which stage line is nearest" is ambiguous — it put stage 1 across 189
  // miles of the course. The stages are instead consecutive segments of the
  // master line, so walk it forward: locate each stage's endpoints in order,
  // never searching behind the previous stage's finish.
  // Search forward only, and not until at least `minMiles` of course has gone
  // by. Without that floor a stage's finish matches its own start: five of the
  // six begin and end at the same handful of Breckenridge trailheads, and the
  // Ice Rink alone appears at mile 0, 185 and 216.
  const nearestIndexFrom = (target, fromIdx, minMiles = 0, maxMiles = Infinity) => {
    const floor = megaCum[fromIdx] + minMiles;
    const ceil = megaCum[fromIdx] + maxMiles;
    let best = -1;
    let bestD = Infinity;
    for (let i = fromIdx; i < megaRaw.length; i++) {
      if (megaCum[i] < floor) continue;
      if (megaCum[i] > ceil) break;
      const d = (megaRaw[i][0] - target[0]) ** 2 + (megaRaw[i][1] - target[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { idx: best === -1 ? fromIdx : best, milesOff: Math.sqrt(bestD) * 69 };
  };

  let cursor = 0;
  const rawSpans = [];
  for (const [n, folderKey] of STAGE_ORDER) {
    const feat = lines.find((f) => folderOf(f).includes(folderKey));
    if (!feat) continue;
    const coords = feat.geometry.coordinates;
    const ownMiles = lineMiles(coords);

    // Stage 1 starts the whole effort, so it anchors at mile zero. Each later
    // stage begins within a few miles of the previous finish — the six stage
    // lines total 211.9 of the master line's 216.0, so all transfers together
    // are about four miles. An 8-mile window is generous and stops a matching
    // trailhead a hundred miles downcourse from winning.
    const head = n === 1 ? { idx: 0, milesOff: 0 } : nearestIndexFrom(coords[0], cursor, 0, 8);
    const tail = nearestIndexFrom(
      coords[coords.length - 1],
      head.idx,
      ownMiles * 0.6,
      ownMiles * 1.4
    );

    rawSpans.push({
      stage: n,
      from: head.idx,
      to: tail.idx,
      ownMiles,
      fitMiles: Math.max(head.milesOff, tail.milesOff),
    });
    cursor = tail.idx;
  }

  const stageAtRawIdx = (i) => rawSpans.find((s) => i >= s.from && i <= s.to)?.stage ?? null;

  const cumMiles = megaKeep.map((i) => Number(megaCum[i].toFixed(3)));
  const cum = megaCum[megaCum.length - 1];
  const vertexStage = megaKeep.map(stageAtRawIdx);

  const stageSpans = rawSpans.map((s) => ({
    stage: s.stage,
    name: STAGE_ORDER.find(([n]) => n === s.stage)[2],
    startMile: Number(megaCum[s.from].toFixed(2)),
    endMile: Number(megaCum[s.to].toFixed(2)),
    miles: Number((megaCum[s.to] - megaCum[s.from]).toFixed(2)),
  }));

  console.log('\nstage spans located along the master line');
  let covered = 0;
  for (const s of stageSpans) {
    const own = rawSpans.find((r) => r.stage === s.stage).ownMiles;
    const delta = s.miles - own;
    covered += s.miles;
    console.log(
      `  ${s.stage}  ${String(s.startMile).padStart(6)} -> ${String(s.endMile).padStart(6)} mi` +
        ` = ${String(s.miles.toFixed(1)).padStart(5)}  (own line ${own.toFixed(1)}, ${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`
    );
  }
  console.log(`  stages cover ${covered.toFixed(1)} of ${cum.toFixed(1)} mi — ${(cum - covered).toFixed(1)} mi of transfers`);

  await write('course-index.json', {
    tolerance: TOLERANCE,
    totalMiles: Number(cum.toFixed(2)),
    // Flat arrays: markedly smaller than an array of objects once gzipped.
    lon: megaSimple.map((c) => c[0]),
    lat: megaSimple.map((c) => c[1]),
    cumMiles,
    stage: vertexStage,
    stageSpans,
  });

  /* ---- markers ---- */

  const counts = { aid: 0, water: 0, crossing: 0, landmark: 0 };
  const markers = [];
  for (const f of feats) {
    if (f.geometry?.type !== 'Point') continue;
    const title = f.properties?.title || '';
    const kind = classifyMarker(title);
    counts[kind]++;
    if (kind === 'aid') continue; // deliberately not shipped

    const folder = folderOf(f);
    const stage = STAGE_ORDER.find(([, k]) => folder.includes(k))?.[0] ?? null;
    const [lon, lat] = f.geometry.coordinates;

    // Mileage is resolved here, inside the marker's own stage, rather than in
    // the browser. Snapping globally puts a stage 1 water point at mile 113
    // because the course revisits the same ground, which then surfaces as a
    // crew intercept a hundred miles from where it actually is.
    const span = rawSpans.find((s) => s.stage === stage);
    const lo = span ? span.from : 0;
    const hi = span ? span.to : megaRaw.length - 1;
    let bestI = lo;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = (megaRaw[i][0] - lon) ** 2 + (megaRaw[i][1] - lat) ** 2;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }

    markers.push({
      type: 'Feature',
      properties: {
        title,
        kind,
        climb: kind === 'landmark' && isClimb(title),
        stage,
        mile: Number(megaCum[bestI].toFixed(2)),
        offMiles: Number((Math.sqrt(bestD) * 69).toFixed(2)),
      },
      geometry: { type: 'Point', coordinates: [round(lon), round(lat)] },
    });
  }
  await write('markers.geojson', { type: 'FeatureCollection', features: markers });

  /* ---- hazard polygons ---- */

  const polys = feats
    .filter((f) => /Polygon/.test(f.geometry?.type ?? ''))
    .map((f) => ({
      type: 'Feature',
      properties: { title: f.properties?.title || '', kind: 'hazard' },
      geometry: {
        type: f.geometry.type,
        coordinates:
          f.geometry.type === 'Polygon'
            ? f.geometry.coordinates.map((ring) => ring.map((c) => [round(c[0]), round(c[1])]))
            : f.geometry.coordinates.map((poly) =>
                poly.map((ring) => ring.map((c) => [round(c[0]), round(c[1])]))
              ),
      },
    }));
  await write('hazards.geojson', { type: 'FeatureCollection', features: polys });

  /* ---- report ---- */

  const totalOut = written.reduce((s, w) => s + w.bytes, 0);
  console.log(`\nSource ${SRC}: ${(srcBytes / 1048576).toFixed(2)} MB`);
  console.log(`Tolerance ${TOLERANCE} deg (~${Math.round(TOLERANCE * 111320)} m)\n`);
  console.log('stage  name                  points          miles              bytes');
  for (const r of report) {
    const drop = (100 * (1 - r.keptPoints / r.rawPoints)).toFixed(1);
    console.log(
      `  ${r.stage}    ${r.name.padEnd(20)} ${String(r.rawPoints).padStart(6)} -> ${String(r.keptPoints).padStart(5)}` +
        ` (-${drop}%)  ${r.rawMiles.toFixed(2)} -> ${r.keptMiles.toFixed(2)}  ${String(r.bytes).padStart(7)}`
    );
  }
  console.log(
    `\nmega     ${String(megaRaw.length).padStart(6)} -> ${megaSimple.length} points; ` +
      `drawn line ${lineMiles(megaSimple).toFixed(2)} mi, ` +
      `distances carried from full-resolution ${cum.toFixed(2)} mi`
  );
  console.log(`\nmarkers: ${counts.landmark} landmark/climb, ${counts.crossing} crossing, ${counts.water} water, ${counts.aid} aid (excluded)`);
  console.log(`hazard polygons: ${polys.length}`);
  console.log('\nwritten:');
  written.forEach((w) => console.log(`  ${w.name.padEnd(22)} ${String(w.bytes).padStart(8)} B`));
  console.log(
    `\ntotal ${(totalOut / 1024).toFixed(1)} kB from ${(srcBytes / 1048576).toFixed(2)} MB ` +
      `— ${(srcBytes / totalOut).toFixed(0)}x smaller\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
