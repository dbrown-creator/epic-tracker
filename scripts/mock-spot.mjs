#!/usr/bin/env node
/**
 * A stand-in for SPOT's public feed API, used to exercise the poller without
 * burning real feed calls (SPOT asks for 2.5 minutes between calls).
 *
 * It reproduces the three response shapes the README documents, plus the
 * failure modes the poller has to survive unattended at 3am.
 *
 * Usage:
 *   node scripts/mock-spot.mjs --scenario normal --port 8787
 *
 * Scenarios:
 *   normal        a few hundred fixes, paged 50 at a time
 *   single        exactly one message, returned as a bare object not an array
 *   nodata        the E-0195 error envelope a quiet feed returns
 *   unpositioned  includes HELP-CANCEL / STOP rows reporting lat/lon -99999
 *   help          includes a HELP message
 *   malformed     valid HTTP, truncated JSON body
 *   partial       first page fine, second page 500s
 *   ratelimit     429 twice, then succeeds
 *   slow          delays past a short timeout
 */

import { createServer } from 'node:http';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const SCENARIO = arg('scenario', 'normal');
const PORT = Number(arg('port', 8787));
const COUNT = Number(arg('count', 240));

// Deterministic pseudo-track climbing out of Breckenridge, so runs are
// reproducible and diffs are meaningful.
const START_MS = Date.parse('2026-08-12T15:00:00Z'); // 09:00 MDT
function fix(i) {
  const t = Math.floor((START_MS + i * 10 * 60 * 1000) / 1000);
  return {
    id: String(1000000 + i),
    messengerId: '0-1234567',
    messengerName: 'Mega Epic',
    unixTime: t,
    messageType: 'TRACK',
    latitude: 39.4817 + Math.sin(i / 18) * 0.045 + i * 0.00021,
    longitude: -106.0384 + Math.cos(i / 22) * 0.05 + i * 0.00018,
    modelId: 'SPOT4',
    showCustomMsg: 'Y',
    dateTime: new Date(t * 1000).toISOString().replace('.000Z', '+0000'),
    batteryState: 'GOOD',
    hidden: 0,
    altitude: 3000 + Math.round(Math.sin(i / 9) * 400),
  };
}

const ALL = Array.from({ length: COUNT }, (_, i) => fix(i));

if (SCENARIO === 'unpositioned') {
  ALL.splice(12, 0, {
    ...fix(12),
    id: '9000001',
    messageType: 'HELP-CANCEL',
    latitude: -99999,
    longitude: -99999,
  });
  ALL.splice(40, 0, {
    ...fix(40),
    id: '9000002',
    messageType: 'STOP',
    latitude: -99999,
    longitude: -99999,
  });
}

if (SCENARIO === 'help') {
  ALL.splice(30, 0, { ...fix(30), id: '9100001', messageType: 'HELP' });
}

const errorEnvelope = (code, text) => ({
  response: { errors: { error: { code, text, description: text } } },
});

const okEnvelope = (messages, totalCount, start) => ({
  response: {
    feedMessageResponse: {
      count: messages.length,
      feed: {
        id: 'MOCKFEED0000000000000000000000',
        name: 'Mega Epic',
        description: 'Mock feed',
        status: 'ACTIVE',
      },
      totalCount,
      activityCount: 0,
      // The documented quirk: one message comes back bare, not wrapped.
      messages: { message: messages.length === 1 ? messages[0] : messages },
    },
  },
});

let rateLimitHits = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const start = Number(url.searchParams.get('start') || 1);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (SCENARIO === 'nodata') {
    return send(200, errorEnvelope('E-0195', 'No Messages to display'));
  }

  if (SCENARIO === 'malformed') {
    return send(200, '{"response":{"feedMessageResponse":{"messages":{"mess');
  }

  if (SCENARIO === 'ratelimit') {
    if (rateLimitHits++ < 2) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify(errorEnvelope('E-0160', 'Rate limit exceeded')));
    }
  }

  if (SCENARIO === 'slow') {
    await new Promise((r) => setTimeout(r, 20000));
  }

  if (SCENARIO === 'single') {
    return send(200, okEnvelope(ALL.slice(0, 1), 1, start));
  }

  if (SCENARIO === 'partial' && start > 1) {
    return send(500, errorEnvelope('E-0500', 'Internal error'));
  }

  const page = ALL.slice(start - 1, start - 1 + 50);
  if (!page.length) {
    return send(200, errorEnvelope('E-0195', 'No Messages to display'));
  }
  return send(200, okEnvelope(page, ALL.length, start));
});

server.listen(PORT, () => {
  console.log(`mock SPOT [${SCENARIO}] on http://localhost:${PORT} (${ALL.length} messages)`);
});
