#!/usr/bin/env node
/**
 * Draws the six stages as one static SVG for the landing page.
 *
 * No tiles, no Leaflet, no JavaScript — the landing page is the thing people
 * open first, often on a phone with one bar, and it should render instantly
 * whether or not anything else on the internet is having a good day.
 *
 *   node scripts/build-landing-map.mjs   ->  docs/course-map.svg
 */

import { readFile, writeFile } from 'node:fs/promises';

const W = 900;
const H = 700;
const PAD = 28;

async function main() {
  const cfgSrc = await readFile('docs/config.js', 'utf8');
  const win = {};
  new Function('window', cfgSrc)(win);
  const CFG = win.RACE_CONFIG;

  const stages = [];
  for (const s of CFG.stages) {
    const geo = JSON.parse(await readFile(`docs/courses/stage-${s.n}.geojson`, 'utf8'));
    stages.push({ ...s, coords: geo.geometry.coordinates });
  }

  // Equirectangular, scaled about the course so it is not stretched.
  const all = stages.flatMap((s) => s.coords);
  const lats = all.map((c) => c[1]);
  const lons = all.map((c) => c[0]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);

  const spanX = (maxLon - minLon) * kx;
  const spanY = maxLat - minLat;
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;

  const px = (c) => ((c[0] - minLon) * kx * scale + offX).toFixed(1);
  const py = (c) => (H - ((c[1] - minLat) * scale + offY)).toFixed(1);
  const path = (coords) => coords.map((c, i) => `${i ? 'L' : 'M'}${px(c)} ${py(c)}`).join('');

  const start = stages[0].coords[0];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="The six Breck Epic stage courses">
<title>Breck Epic — all six stages</title>
<rect width="${W}" height="${H}" fill="#EDE4D3"/>
<g fill="none" stroke-linejoin="round" stroke-linecap="round">
${stages.map((s) => `  <path d="${path(s.coords)}" stroke="#EDE4D3" stroke-width="6" opacity=".8"/>`).join('\n')}
${stages.map((s) => `  <path d="${path(s.coords)}" stroke="${s.color}" stroke-width="2.4" opacity=".92"><title>Stage ${s.n} — ${s.name}</title></path>`).join('\n')}
</g>
<g>
  <circle cx="${px(start)}" cy="${py(start)}" r="7" fill="#BF3B2B" stroke="#EDE4D3" stroke-width="2.5"/>
  <text x="${px(start)}" y="${Number(py(start)) - 14}" text-anchor="middle"
        font-family="ui-monospace, monospace" font-size="13" font-weight="600" fill="#2A2622">START</text>
</g>
<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" fill="none" stroke="#6E4A26" stroke-width="1.5"/>
</svg>
`;

  await writeFile('docs/course-map.svg', svg);
  console.log(`docs/course-map.svg  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} kB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
