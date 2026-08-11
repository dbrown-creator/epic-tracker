#!/usr/bin/env node
/**
 * Pull messages from a SPOT public XML/JSON feed and merge them into a local
 * archive file. The SPOT API only serves the last 7 days, so this file is the
 * permanent record — never truncate it.
 *
 * Env:
 *   SPOT_FEED_ID        required, 32-char feed id from Settings & Billing > XML Feed
 *   SPOT_FEED_PASSWORD  optional, only if the feed is password protected
 *   OUT_PATH            optional, defaults to docs/data/track.json
 *   MAX_PAGES           optional, defaults to 8 (50 messages per page)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const FEED_ID = process.env.SPOT_FEED_ID;
const FEED_PASSWORD = process.env.SPOT_FEED_PASSWORD || '';
const OUT = process.env.OUT_PATH || 'docs/data/track.json';
const MAX_PAGES = Number(process.env.MAX_PAGES || 8);
const PAGE_SIZE = 50;
const BASE =
  process.env.SPOT_API_BASE ||
  'https://api.findmespot.com/spot-main-web/consumer/rest-api/2.0/public/feed';

if (!FEED_ID) {
  console.error('SPOT_FEED_ID is not set. Add it as a repository secret.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SPOT collapses single-element lists into bare objects. Always ask for an array. */
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function pageUrl(start) {
  const u = new URL(`${BASE}/${FEED_ID}/message.json`);
  if (start > 1) u.searchParams.set('start', String(start));
  if (FEED_PASSWORD) u.searchParams.set('feedPassword', FEED_PASSWORD);
  return u.toString();
}

async function fetchPage(start) {
  const res = await fetch(pageUrl(start), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const body = await res.json();
  const root = body?.response;

  // A feed with nothing in the window returns an error envelope, not an empty list.
  const errors = asArray(root?.errors?.error);
  if (errors.length) {
    const noData = errors.some((e) => String(e.code || '').includes('0195'));
    if (noData) return { messages: [], feed: null, exhausted: true };
    const detail = errors.map((e) => `${e.code}: ${e.text || e.description}`).join('; ');
    throw new Error(`SPOT API error — ${detail}`);
  }

  const fmr = root?.feedMessageResponse;
  return {
    messages: asArray(fmr?.messages?.message),
    feed: fmr?.feed ?? null,
    exhausted: false,
  };
}

/** Non-position messages (HELP-CANCEL, some STOP) report lat/lon as -99999. */
function normalize(m) {
  const lat = Number(m.latitude);
  const lon = Number(m.longitude);
  const positioned =
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  return {
    id: String(m.id),
    t: Number(m.unixTime),
    iso: m.dateTime ?? null,
    lat: positioned ? lat : null,
    lon: positioned ? lon : null,
    type: m.messageType ?? 'UNKNOWN',
    text: m.messageContent ?? null,
    battery: m.batteryState ?? null,
    positioned,
  };
}

async function readArchive() {
  try {
    const raw = await readFile(OUT, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      feed: parsed.feed ?? null,
      points: Array.isArray(parsed.points) ? parsed.points : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not parse ${OUT}, starting fresh: ${err.message}`);
    return { feed: null, points: [] };
  }
}

async function main() {
  const archive = await readArchive();
  const byId = new Map(archive.points.map((p) => [p.id, p]));
  const before = byId.size;

  let feedMeta = archive.feed;
  let fetched = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE + 1;
    if (page > 0) await sleep(3000); // be polite between paged calls

    const { messages, feed, exhausted } = await fetchPage(start);
    if (feed) feedMeta = { id: feed.id, name: feed.name, description: feed.description };
    if (exhausted) break;

    for (const m of messages) {
      const p = normalize(m);
      if (Number.isFinite(p.t)) byId.set(p.id, p);
    }
    fetched += messages.length;

    // Short page means we've reached the end of the available window.
    if (messages.length < PAGE_SIZE) break;

    // Stop paging once we're only re-reading messages we already had.
    const allKnown = messages.every((m) => archive.points.some((p) => p.id === String(m.id)));
    if (allKnown) break;
  }

  const points = [...byId.values()].sort((a, b) => a.t - b.t);
  const added = points.length - before;

  const next = { feed: feedMeta, count: points.length, points };
  const serialized = JSON.stringify(next, null, 2) + '\n';

  let current = null;
  try {
    current = await readFile(OUT, 'utf8');
  } catch {
    /* first run */
  }

  if (current === serialized) {
    console.log(`No change. ${points.length} points on file (fetched ${fetched} messages).`);
    return;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, serialized);
  console.log(`Wrote ${OUT} — ${points.length} points (${added >= 0 ? '+' : ''}${added} new).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
