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

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const FEED_ID = process.env.SPOT_FEED_ID;
const FEED_PASSWORD = process.env.SPOT_FEED_PASSWORD || '';
const OUT = process.env.OUT_PATH || 'docs/data/track.json';
// Health lives beside the archive rather than inside it. track.json is the
// permanent record and its shape should not churn; this file is disposable
// and rewritten every run, which is what makes it a heartbeat.
const STATUS_OUT = process.env.STATUS_PATH || OUT.replace(/track\.json$/, 'status.json');
const MAX_PAGES = Number(process.env.MAX_PAGES || 8);
const PAGE_SIZE = 50;
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 2000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
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

/**
 * One attempt. Separated from the retry wrapper so the caller can tell a
 * retryable transport failure from a permanent one.
 */
async function fetchPageOnce(start) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(pageUrl(start), {
      headers: { accept: 'application/json' },
      signal: ctl.signal,
    });
  } catch (err) {
    // Abort, DNS failure, connection reset — all worth another go.
    throw Object.assign(new Error(`network: ${err.name === 'AbortError' ? 'timed out' : err.message}`), {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 429 and 5xx are transient. 4xx otherwise means the feed ID is wrong or
    // the feed is gone, and retrying just burns the rate limit.
    const retryable = res.status === 429 || res.status >= 500;
    throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
      retryable,
      retryAfter: Number(res.headers.get('retry-after')) || 0,
    });
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    // A truncated or HTML body (captive portal, edge error page) is transient.
    throw Object.assign(new Error(`unparseable response: ${err.message}`), { retryable: true });
  }
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
  if (!fmr) {
    // Valid JSON but not a shape we recognise. Treat as transient rather than
    // silently reporting zero messages, which would look like a quiet feed.
    throw Object.assign(new Error('response had neither feedMessageResponse nor errors'), {
      retryable: true,
    });
  }
  return {
    messages: asArray(fmr?.messages?.message),
    feed: fmr?.feed ?? null,
    exhausted: false,
  };
}

/**
 * Retries transient failures with exponential backoff. The cron fires every
 * five minutes, so this only needs to ride out a brief wobble — not to keep
 * trying for ever. Giving up quietly is fine; the next run picks it up.
 */
async function fetchPage(start) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchPageOnce(start);
    } catch (err) {
      lastErr = err;
      if (!err.retryable || attempt === MAX_RETRIES) throw err;
      const backoff = err.retryAfter
        ? err.retryAfter * 1000
        : Math.min(RETRY_BASE_MS * 2 ** attempt, 30000);
      console.warn(`  ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
  throw lastErr;
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
  let pollError = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE + 1;
    if (page > 0) await sleep(3000); // be polite between paged calls

    let result;
    try {
      result = await fetchPage(start);
    } catch (err) {
      // Keep whatever earlier pages gave us rather than throwing the run away.
      // Page 1 is the newest data and the part that matters; losing pages 2+
      // costs backfill depth, which the next run recovers anyway.
      pollError = err.message;
      console.warn(`Page ${page + 1} failed: ${err.message}`);
      break;
    }
    const { messages, feed, exhausted } = result;
    // Deliberately not feed.id — the API echoes the feed ID back, and this
    // object gets committed to a public repo. Anyone holding that ID can read
    // a week of position history.
    if (feed) feedMeta = { name: feed.name, description: feed.description, status: feed.status };
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

  // The archive is the only copy — SPOT drops everything older than 7 days.
  // No legitimate path shrinks it, so treat shrinkage as a bug and abort
  // rather than overwrite good history with bad.
  if (points.length < archive.points.length) {
    throw new Error(
      `Refusing to write: archive would shrink from ${archive.points.length} to ${points.length} points.`
    );
  }

  const next = { feed: feedMeta, count: points.length, points };
  const serialized = JSON.stringify(next, null, 2) + '\n';

  // This file is committed to a public repo. Refuse to write rather than ever
  // publish the credential, whatever future edits do upstream of here.
  if (serialized.includes(FEED_ID)) {
    throw new Error('Refusing to write: output contains the feed ID.');
  }

  let current = null;
  try {
    current = await readFile(OUT, 'utf8');
  } catch {
    /* first run */
  }

  const summary = { points: points.length, lastFixT: points.at(-1)?.t, fetched };

  if (current === serialized) {
    console.log(`No change. ${points.length} points on file (fetched ${fetched} messages).`);
    // Nothing new and the poll also failed: nothing to commit, so surface it
    // as a red run rather than a green one that quietly did nothing.
    if (pollError) throw new Error(`Poll failed and no new data: ${pollError}`);
    return summary;
  }

  await mkdir(dirname(OUT), { recursive: true });

  // Write-then-rename. A process killed mid-write (runner eviction, Ctrl-C on
  // the fallback loop) would otherwise leave a truncated archive, and there is
  // no upstream copy to restore from after 7 days.
  const tmp = `${OUT}.${process.pid}.tmp`;
  await writeFile(tmp, serialized);
  await rename(tmp, OUT);

  console.log(`Wrote ${OUT} — ${points.length} points (${added >= 0 ? '+' : ''}${added} new).`);
  if (pollError) console.warn(`Partial poll: kept what arrived before "${pollError}".`);
  return summary;
}

/**
 * The heartbeat. Written on every run, success or failure, so the page can
 * tell "he has stopped moving" from "the pipeline has stopped running" —
 * which look identical if all you have is the age of the last fix.
 */
async function writeStatus({ ok, error, points, lastFixT, fetched }) {
  const status = {
    polledAt: new Date().toISOString(),
    ok,
    error: error ? String(error).slice(0, 300) : null,
    points: points ?? null,
    lastFixAt: Number.isFinite(lastFixT) ? lastFixT : null,
    fetched: fetched ?? 0,
    intervalMinutes: Number(process.env.POLL_INTERVAL_MINUTES || 10),
  };
  try {
    await mkdir(dirname(STATUS_OUT), { recursive: true });
    const tmp = `${STATUS_OUT}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(status, null, 2) + '\n');
    await rename(tmp, STATUS_OUT);
  } catch (err) {
    // A missing heartbeat is itself a signal; never let it fail the run.
    console.warn(`Could not write ${STATUS_OUT}: ${err.message}`);
  }
}

main()
  .then((summary) => writeStatus({ ok: true, error: null, ...summary }))
  .catch(async (err) => {
    console.error(err.message);
    // Record the failure before exiting, so the page can say what went wrong
    // rather than just going quiet.
    const existing = await readArchive();
    await writeStatus({
      ok: false,
      error: err.message,
      points: existing.points.length,
      lastFixT: existing.points.at(-1)?.t,
    });
    process.exit(1);
  });
