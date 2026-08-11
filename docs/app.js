/* global L */
(function () {
  'use strict';

  const CFG = window.RACE_CONFIG;
  const PING_MS = CFG.pingIntervalMinutes * 60 * 1000;
  const STALE_MS = CFG.staleAfterMinutes * 60 * 1000;
  const POLLER_STALE_MS = (CFG.pollerStaleAfterMinutes || 30) * 60 * 1000;
  const PING_SLOTS = 12;
  const OFF_COURSE_MILES = 0.5;

  const $ = (id) => document.getElementById(id);

  /* ---------- time ---------- */

  /**
   * Offset of a zone at a given instant, in ms. Derived from the zone rather
   * than written down: the race crosses two midnights, and an offset that is
   * correct today is not a fact about the zone.
   */
  function zoneOffsetMs(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = {};
    for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
    return asUTC - date.getTime();
  }

  /** Local wall-clock in a zone -> UTC instant. Two passes settle DST edges. */
  function zonedToUtc(localISO, timeZone) {
    const naive = Date.parse(`${localISO}Z`);
    if (!Number.isFinite(naive)) return NaN;
    let ts = naive;
    for (let i = 0; i < 2; i++) ts = naive - zoneOffsetMs(new Date(ts), timeZone);
    return ts;
  }

  const START_MS = zonedToUtc(CFG.startLocal, CFG.timeZone);

  const clockFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: CFG.timeZone,
  });
  const timeOnlyFmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: CFG.timeZone,
  });
  // Full date for the start: over a three-day effort "Wed 9:00 AM" is not
  // enough on its own, especially for anyone opening the page cold.
  const fullDateFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: CFG.timeZone,
  });

  function hhmm(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const total = Math.floor(ms / 60000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function ago(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  }

  /* ---------- geometry ---------- */

  const R_MILES = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  // Equirectangular scaling about the course. Distances here are a few miles
  // at most, where this is accurate to well under a metre and much cheaper
  // than haversine inside the snapping loop.
  const LAT_SCALE = R_MILES * (Math.PI / 180);
  const LON_SCALE = LAT_SCALE * Math.cos(toRad(39.5));

  function haversineMiles(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_MILES * Math.asin(Math.sqrt(s));
  }

  /* ---------- course ---------- */

  const course = {
    loaded: false,
    lon: null,
    lat: null,
    cumMiles: null,
    stageSpans: [],
    totalMiles: CFG.totalMiles,
    markers: [],
  };

  /** Most recent named climb or landmark at or behind a course mileage. */
  function featureAt(mile) {
    let behind = null;
    for (const m of course.markers) {
      if (m.kind !== 'landmark' || m.mile == null) continue;
      if (m.mile <= mile + 0.15 && (!behind || m.mile > behind.mile)) behind = m;
    }
    // Only claim he is "on" something within a few miles of passing it.
    if (behind && mile - behind.mile <= 4) return behind;
    return null;
  }

  /** Next road crossing ahead — the only places a vehicle can reach him. */
  function nextCrossing(mile) {
    let best = null;
    for (const m of course.markers) {
      if ((m.kind !== 'crossing' && m.kind !== 'water') || m.mile == null) continue;
      if (m.mile > mile + 0.2 && (!best || m.mile < best.mile)) best = m;
    }
    return best;
  }

  /* ---------- plan versus actual ---------- */

  /**
   * The schedule as a curve of (hours elapsed -> course mile), built by pinning
   * each stage's planned start and finish to where that stage actually sits on
   * the master line. Rests are flat sections: the plan holds position between a
   * stage finish and the next start.
   *
   * The rail shows the plan and the map shows the truth. This is the number
   * that says whether they agree.
   */
  let planCurve = null;

  function buildPlanCurve() {
    if (!course.stageSpans.length) return null;
    const pts = [];
    for (const s of CFG.stages) {
      const span = course.stageSpans.find((x) => x.stage === s.n);
      if (!span) continue;
      pts.push({ h: s.startOffsetHours, mile: span.startMile });
      pts.push({ h: s.startOffsetHours + s.durationHours, mile: span.endMile });
    }
    pts.sort((a, b) => a.h - b.h);
    return pts.length >= 2 ? pts : null;
  }

  /** When the plan expected him to reach a given mile, in hours elapsed. */
  function plannedHoursAtMile(mile) {
    if (!planCurve) return null;
    if (mile <= planCurve[0].mile) return planCurve[0].h;
    for (let i = 1; i < planCurve.length; i++) {
      const a = planCurve[i - 1];
      const b = planCurve[i];
      if (mile <= b.mile) {
        // A rest is flat in distance; the plan reaches that mile at its start.
        if (b.mile === a.mile) return a.h;
        return a.h + ((mile - a.mile) / (b.mile - a.mile)) * (b.h - a.h);
      }
    }
    return planCurve[planCurve.length - 1].h;
  }

  /** Where the plan says he should be right now. */
  function plannedMileAtHours(h) {
    if (!planCurve) return null;
    if (h <= planCurve[0].h) return planCurve[0].mile;
    for (let i = 1; i < planCurve.length; i++) {
      const a = planCurve[i - 1];
      const b = planCurve[i];
      if (h <= b.h) {
        if (b.h === a.h) return b.mile;
        return a.mile + ((h - a.h) / (b.h - a.h)) * (b.mile - a.mile);
      }
    }
    return planCurve[planCurve.length - 1].mile;
  }

  /* ---------- stage status ---------- */

  // Snapping is the expensive part of this page, so each fix is snapped once
  // and remembered. Over 58 hours that is a few hundred entries.
  const mileCache = new Map();
  let maxMileSeen = 0;

  /**
   * Which stage the schedule says he is on at a given elapsed time, and
   * whether he should be between stages.
   *
   * The stages are ridden 1 through 6 in sequence with no variation, so the
   * schedule alone narrows the position to one stage — which is what makes the
   * course's self-overlap tractable. Time proposes; position confirms.
   */
  function scheduledStageAt(elapsedH) {
    if (elapsedH < 0) return { stage: null, state: 'before' };
    for (const s of CFG.stages) {
      const a = s.startOffsetHours;
      const b = a + s.durationHours;
      if (elapsedH >= a && elapsedH <= b) return { stage: s.n, state: 'on' };
    }
    // In a gap: name it from the breaks list.
    let prev = null;
    for (const s of CFG.stages) {
      if (elapsedH > s.startOffsetHours + s.durationHours) prev = s.n;
    }
    if (prev == null) return { stage: null, state: 'before' };
    if (prev >= CFG.stages.length) return { stage: null, state: 'after' };
    const br = CFG.breaks.find((b) => b.afterStage === prev);
    return { stage: null, state: 'break', afterStage: prev, label: br ? br.label : 'Between stages', kind: br ? br.kind : 'stop' };
  }

  /**
   * Resolve a fix to a stage and a course mileage.
   *
   * Candidates are the stage the schedule implies plus its neighbours, so
   * being an hour up or down the road still resolves correctly — but the Ice
   * Rink at mile 216 is never a candidate while the clock says stage 1. The
   * best fit by perpendicular distance wins.
   */
  function resolveFix(lat, lon, elapsedH, floorStage, prevMile = null) {
    if (!course.loaded || !course.stageSpans.length) return null;
    const sched = scheduledStageAt(elapsedH);
    // During a break he is parked at the finish of the stage he just rode, not
    // at the start of the next one — even though those are the same trailhead.
    const centre =
      sched.stage ?? (sched.state === 'break' ? sched.afterStage : sched.state === 'after' ? 6 : 1);

    const candidates = [];
    for (let n = centre - 1; n <= centre + 1; n++) {
      if (n < 1 || n > CFG.stages.length) continue;
      // Never resolve backwards past a stage already completed.
      if (floorStage && n < floorStage) continue;
      const span = course.stageSpans.find((x) => x.stage === n);
      if (span) candidates.push(span);
    }
    if (!candidates.length) return null;

    // Stages share trailheads, so a fix at a stage finish sits exactly on the
    // next stage's start too. Position alone cannot separate those; the clock
    // can. A neighbouring stage has to fit measurably better than the one the
    // schedule expects before it wins.
    const OFF_SCHEDULE_PENALTY = 0.15; // miles

    // Continuity inside the stage as well as between stages. A stage can begin
    // and end at the same trailhead — stage 2 runs Lower Washington to B&B, and
    // the master line puts Lower Washington at both mile 36 and mile 77 — so
    // without this a fix at the start of a stage snaps to its finish.
    const JUMP_MILES = 25; // covers a 90-minute outage at any plausible pace

    let best = null;
    for (const span of candidates) {
      const lo = prevMile == null ? span.startMile : Math.max(span.startMile, prevMile - 1);
      const hi = prevMile == null ? span.endMile : Math.min(span.endMile, prevMile + JUMP_MILES);
      // An empty window means this stage is not reachable from where he was.
      // Falling back to the whole span here would undo the constraint entirely
      // and let a stage match at a trailhead forty miles up the course.
      if (hi <= lo) continue;
      const snap = snapWithin(lat, lon, lo, hi);
      if (!snap) continue;
      const score = snap.offMiles + (span.stage === centre ? 0 : OFF_SCHEDULE_PENALTY);
      if (!best || score < best.score) best = { ...snap, score, stage: span.stage, span };
    }
    if (!best) return null;

    return {
      mile: best.mile,
      offMiles: best.offMiles,
      onCourse: best.offMiles <= OFF_COURSE_MILES,
      stage: best.stage,
      stageName: (CFG.stages.find((s) => s.n === best.stage) || {}).name || null,
      scheduled: sched,
      // On a break the schedule expects him off-stage; say so rather than
      // reporting a stage he is only near because the trailhead is there.
      transfer: sched.state === 'break',
    };
  }

  /** Nearest point on the course between two mileages. */
  function snapWithin(lat, lon, loMile, hiMile) {
    const { lon: xs, lat: ys, cumMiles } = course;
    const py = lat * LAT_SCALE;
    const px = lon * LON_SCALE;
    let bestD2 = Infinity;
    let bestMile = null;

    for (let i = 1; i < xs.length; i++) {
      if (cumMiles[i] < loMile) continue;
      if (cumMiles[i - 1] > hiMile) break;
      const ax = xs[i - 1] * LON_SCALE, ay = ys[i - 1] * LAT_SCALE;
      const bx = xs[i] * LON_SCALE, by = ys[i] * LAT_SCALE;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = 0;
      if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestMile = cumMiles[i - 1] + t * (cumMiles[i] - cumMiles[i - 1]);
      }
    }
    return bestMile == null ? null : { mile: bestMile, offMiles: Math.sqrt(bestD2) };
  }

  /**
   * Resolved mileage and stage for a fix, computed once and remembered.
   * The stage is taken from the resolver rather than re-derived from the
   * mileage, so the rail and the headline can never disagree — consecutive
   * stages share a boundary mile and re-deriving picks the wrong side of it.
   */
  function resolvedOf(fix, floorStage, prevMile = null) {
    // Never cache before the course index has arrived. The first refresh races
    // the course fetch, and caching a null here permanently marks fixes as
    // unresolvable — which showed up as stages with one fix and 0:00 durations.
    if (!course.loaded) return null;
    if (mileCache.has(fix.id)) return mileCache.get(fix.id);
    const elapsedH = (fix.t * 1000 - START_MS) / 3600000;
    const r = resolveFix(fix.lat, fix.lon, elapsedH, floorStage, prevMile);
    const out = r && r.onCourse ? { mile: r.mile, stage: r.transfer ? r.stage : r.stage } : null;
    mileCache.set(fix.id, out);
    return out;
  }

  /**
   * Per-stage status derived from the track itself, not the clock.
   *
   * Progress is taken as the furthest point reached rather than the latest, so
   * a fix that snaps backwards — off-course scatter, or the course doubling
   * back on itself — cannot un-finish a stage that was already completed.
   */
  /**
   * Walks the whole track once, deciding which stage each fix belongs to.
   *
   * The stages are ridden 1 through 6 in sequence, and every change of stage
   * involves a long stop in town to reload and eat. That stop is a far better
   * transition signal than the clock: it is behaviour rather than intention,
   * and it stays correct when the ride runs hours off plan. So the stage only
   * advances when a stop qualifies — long enough, close enough to town, and
   * with most of the current stage already behind him.
   *
   * Position then confirms: each fix is snapped inside the stage the walk
   * believes it is on. Time is not consulted at all here; it is only a
   * fallback for labelling before any fixes exist.
   */
  const HUB = CFG.hub || { lat: 39.4817, lon: -106.0384, radiusMiles: 3 };
  const STOP_MS = (CFG.transitionStopMinutes || 30) * 60000;
  const STOP_RADIUS = CFG.stopRadiusMiles || 0.35;
  const STAGE_FRACTION = CFG.minStageFractionBeforeTransition ?? 0.6;

  let walkCache = { count: -1, result: null };

  function walkFixes(fixes) {
    if (!course.loaded || !course.stageSpans.length) return null;
    if (walkCache.count === fixes.length && walkCache.result) return walkCache.result;

    const spans = course.stageSpans;
    const spanOf = (n) => spans.find((x) => x.stage === n);
    const nearHub = (p) =>
      haversineMiles({ lat: p.lat, lon: p.lon }, { lat: HUB.lat, lon: HUB.lon }) <= HUB.radiusMiles;

    let stage = 1;
    let prevMile = null;
    let anchor = null; // first fix of the current stationary cluster
    let counted = false; // this cluster has already advanced the stage
    let maxMileInStage = null;

    const resolved = [];
    const transitions = [];

    for (const f of fixes) {
      // Anything before the gun is him moving around town, not progress.
      if (f.t * 1000 < START_MS) {
        resolved.push({ t: f.t, id: f.id, mile: null, stage: null, stopped: false });
        continue;
      }

      // --- stationary clustering ---
      if (!anchor || haversineMiles(f, anchor) > STOP_RADIUS) {
        anchor = f;
        counted = false;
      }
      const stoppedMs = (f.t - anchor.t) * 1000;
      const isStopped = stoppedMs >= 2 * PING_MS;

      // --- transition test ---
      const span = spanOf(stage);
      const covered = span && maxMileInStage != null ? maxMileInStage - span.startMile : 0;
      const enough = span ? covered >= STAGE_FRACTION * span.miles : false;

      if (!counted && stage < CFG.stages.length && stoppedMs >= STOP_MS && nearHub(anchor) && enough) {
        transitions.push({ stage: stage + 1, t: f.t, mile: maxMileInStage });
        stage += 1;
        counted = true;
        maxMileInStage = null;
        prevMile = spanOf(stage) ? spanOf(stage).startMile : prevMile;
      }

      // --- position, inside the stage the walk believes we are on ---
      let best = null;
      for (const n of [stage, stage + 1]) {
        const sp = spanOf(n);
        if (!sp) continue;
        const lo = prevMile == null || n !== stage ? sp.startMile : Math.max(sp.startMile, prevMile - 1);
        const hi = prevMile == null || n !== stage ? sp.endMile : Math.min(sp.endMile, prevMile + 25);
        if (hi <= lo) continue;
        const snap = snapWithin(f.lat, f.lon, lo, hi);
        if (!snap) continue;
        // The next stage has to fit dramatically better to win without a stop.
        // That covers a transition stop too short to register, without letting
        // a shared trailhead pull him forward a stage.
        const score = snap.offMiles + (n === stage ? 0 : 1.0);
        if (!best || score < best.score) best = { ...snap, score, stage: n };
      }

      // Which stage this stop sits after, decided by the walk rather than
      // inferred from mileage later. The house is 1.1 miles into stage 4, so
      // "has he covered any of the current stage" cannot tell a break after
      // stage 3 from an early start on stage 4.
      const qualifies = stoppedMs >= STOP_MS && nearHub(anchor);
      const breakAfter = counted ? stage - 1 : qualifies && enough ? stage : null;

      if (best && best.offMiles <= OFF_COURSE_MILES) {
        if (best.stage !== stage) {
          transitions.push({ stage: best.stage, t: f.t, mile: best.mile, byPosition: true });
          stage = best.stage;
          maxMileInStage = null;
        }
        prevMile = best.mile;
        maxMileInStage = maxMileInStage == null ? best.mile : Math.max(maxMileInStage, best.mile);
        resolved.push({ t: f.t, id: f.id, mile: best.mile, stage, stopped: isStopped, stoppedMs, breakAfter });
      } else {
        resolved.push({
          t: f.t,
          id: f.id,
          mile: null,
          stage: null,
          offMiles: best ? best.offMiles : null,
          stopped: isStopped,
          stoppedMs,
          breakAfter,
        });
      }
    }

    const result = { resolved, transitions, stage, lastStoppedMs: resolved.length ? resolved[resolved.length - 1].stoppedMs || 0 : 0 };
    walkCache = { count: fixes.length, result };
    return result;
  }

  /** Highest stage number confirmed reached, used as a ratchet. */
  /**
   * The current position, phrased the way the readouts want it. A long stop
   * near town between stages is a break, and named as one — but from the stop
   * itself, not from the clock.
   */
  function currentFromWalk(fixes) {
    const walk = walkFixes(fixes);
    if (!walk) return null;
    const last = [...walk.resolved].reverse().find((r) => r.mile != null);
    const tail = walk.resolved[walk.resolved.length - 1];

    if (!last) {
      return tail
        ? { mile: null, offMiles: tail.offMiles ?? 99, onCourse: false, stage: null, stageName: null, transfer: false }
        : null;
    }

    // Between stages: stopped near town, long enough, with the stage's
    // distance behind him. The label comes from the breaks list.
    const span = course.stageSpans.find((x) => x.stage === last.stage);
    const finishedStage = span && last.mile >= span.endMile - 0.3;
    const parked = (tail.stoppedMs || 0) >= STOP_MS;
    const atHub =
      haversineMiles(
        { lat: fixes[fixes.length - 1].lat, lon: fixes[fixes.length - 1].lon },
        { lat: HUB.lat, lon: HUB.lon }
      ) <= HUB.radiusMiles;

    // Stopped in town between stages he is off the course line — the house
    // sits beside mile 37, nowhere near where he just finished — so snapping
    // reports him lost. Hold the last good position instead and name the
    // break. Being at the house is not being off route.
    const onBreak = parked && atHub;
    // The transition fires during the stop, so by the time the label is read
    // the walk has already advanced. Name the break after the stage he
    // actually finished: if the current stage has no distance on it yet, he
    // has not started it, and the break belongs to the one before.
    const afterStage = tail.breakAfter != null ? tail.breakAfter : last.stage;
    const br = onBreak ? CFG.breaks.find((b) => b.afterStage === afterStage) : null;

    return {
      mile: last.mile,
      offMiles: 0,
      onCourse: onBreak || tail.mile != null,
      stage: last.stage,
      stageName: (CFG.stages.find((s) => s.n === last.stage) || {}).name || null,
      transfer: onBreak,
      scheduled: br ? { label: br.label, kind: br.kind } : { label: 'Between stages', kind: 'stop' },
    };
  }

  /** Mileage of the most recent fix the walk has already resolved. */
  function previousMile(fixes) {
    for (let i = fixes.length - 1; i >= 0; i--) {
      const r = mileCache.get(fixes[i].id);
      if (r && r.mile != null) return r.mile;
    }
    return null;
  }

  function furthestStage(fixes) {
    let best = 0;
    for (const f of fixes) {
      const r = mileCache.get(f.id);
      if (r && r.stage > best) best = r.stage;
    }
    return best;
  }

  function stageStatuses(fixes) {
    const spans = course.stageSpans;
    if (!spans.length) return [];

    // Resolve every fix to a stage, walking forward so the stage only ever
    // ratchets up. Completion is then "a later stage has been seen", which is
    // sound because the stages are ridden 1 through 6 with no variation —
    // rather than "a mileage threshold was crossed", which is not, because
    // consecutive stages share a trailhead and therefore a mileage.
    const walk = walkFixes(fixes);
    if (!walk) return [];

    const seen = new Map(); // stage -> { firstT, lastT, maxMile }
    let peak = -1;
    let floor = 0;
    for (const r of walk.resolved) {
      if (r.stage == null || r.mile == null) continue;
      const f = { t: r.t };
      if (r.stage > floor) floor = r.stage;
      if (r.mile > peak) peak = r.mile;
      const span = spans.find((x) => x.stage === r.stage);
      const rec = seen.get(r.stage) || { firstT: f.t, lastT: f.t, maxMile: r.mile, rollingT: null, endT: null };
      rec.lastT = f.t;
      rec.maxMile = Math.max(rec.maxMile, r.mile);
      // Boundary miles are shared between consecutive stages, so sitting at
      // home between stages otherwise counts against the stage he just rode.
      // Bracket each stage by when he was demonstrably on it, not adjacent
      // to it: a quarter mile in, and a quarter mile from the finish.
      if (span) {
        if (rec.rollingT == null && r.mile > span.startMile + 0.25) rec.rollingT = f.t;
        if (rec.endT == null && r.mile >= span.endMile - 0.25) rec.endT = f.t;
      }
      seen.set(r.stage, rec);
    }
    const current = floor;
    const nowSched = scheduledStageAt((Date.now() - START_MS) / 3600000);

    const elapsedH = (Date.now() - START_MS) / 3600000;
    const deltaH = (() => {
      if (!planCurve || peak < 0 || elapsedH < 0) return 0;
      return elapsedH - plannedHoursAtMile(peak);
    })();

    return CFG.stages.map((s) => {
      const span = spans.find((x) => x.stage === s.n);
      const rec = seen.get(s.n);
      if (!span) return { stage: s, state: 'todo' };

      const startedT = rec ? (rec.rollingT ?? rec.firstT) : null;

      if (current > s.n && rec) {
        const finishedT = rec.endT ?? rec.lastT;
        return {
          stage: s,
          span,
          state: 'done',
          startedT,
          finishedT,
          durationMs: Math.max(0, (finishedT - startedT) * 1000),
        };
      }
      // Done means he covered the stage's distance, full stop. Keying this off
      // "a later stage has been seen" instead makes a stage un-finish at every
      // transition: the schedule moves on before the first fix resolves to the
      // next stage, and for those minutes nothing is past it.
      if (rec && rec.endT) {
        return {
          stage: s,
          span,
          state: 'done',
          startedT,
          finishedT: rec.endT,
          durationMs: Math.max(0, (rec.endT - startedT) * 1000),
        };
      }
      if (current >= s.n && rec) {
        return {
          stage: s,
          span,
          state: 'active',
          startedT,
          runningMs: Date.now() - startedT * 1000,
          milesIn: Math.max(0, rec.maxMile - span.startMile),
          milesTotal: span.miles,
        };
      }
      // Not reached. Project the plan forward by however far behind he is.
      const planStartMs = START_MS + s.startOffsetHours * 3600000;
      return {
        stage: s,
        span,
        state: 'todo',
        etaStartMs: planStartMs + deltaH * 3600000,
        estDurationMs: s.durationHours * 3600000,
        shifted: Math.abs(deltaH) >= 1 / 3,
      };
    });
  }

  /* ---------- stopped or moving ---------- */

  /**
   * Fixes clustering in one place means stopped. Reported separately from the
   * heartbeat: a stationary rider and a dead pipeline both freeze the dot, and
   * conflating them is the failure mode that matters.
   */
  function movementState(fixes, now) {
    if (fixes.length < 2) return null;
    const last = fixes[fixes.length - 1];
    const CLUSTER_MILES = 0.12; // GPS scatter plus a campsite

    let since = last.t;
    for (let i = fixes.length - 2; i >= 0; i--) {
      if (haversineMiles(fixes[i], last) > CLUSTER_MILES) break;
      since = fixes[i].t;
    }
    const stoppedMs = last.t * 1000 - since * 1000;
    // Two consecutive fixes in the same place is noise; three is a stop.
    if (stoppedMs < 2 * PING_MS) return { moving: true };
    return { moving: false, sinceMs: stoppedMs, sinceT: since, ageMs: now - since * 1000 };
  }

  /** Does the marker set cover any ground beyond here at all? */
  function hasCrossingsBeyond(mile) {
    return course.markers.some(
      (m) => (m.kind === 'crossing' || m.kind === 'water') && m.mile != null && m.mile > mile
    );
  }

  /* ---------- map ---------- */

  let map;
  let hasFitBounds = false;
  const layers = {};
  const drawn = { trackLine: null, head: null, dotsFor: -1 };
  const stagePolys = {};
  let emphasised = null;
  let tileErrors = 0;

  // Which stage traces are drawn. Colour now does the work of telling them
  // apart, so this is about reducing clutter rather than rescuing legibility.
  const shown = new Set([1, 2, 3, 4, 5, 6]);

  /** The stage he is on is drawn heavier; the rest stay full colour. */
  function emphasiseStage(n) {
    emphasised = n;
    applyStageStyles();
  }

  function applyStageStyles() {
    for (const [k, pair] of Object.entries(stagePolys)) {
      const num = Number(k);
      const on = shown.has(num);
      const active = num === emphasised;

      for (const layer of [pair.casing, pair.poly]) {
        if (on && !layers.courses.hasLayer(layer)) layers.courses.addLayer(layer);
        if (!on && layers.courses.hasLayer(layer)) layers.courses.removeLayer(layer);
      }
      if (!on) continue;

      pair.casing.setStyle({ weight: active ? 8 : 6 });
      pair.poly.setStyle({ weight: active ? 4.5 : 3, opacity: active ? 1 : 0.85 });
      if (active) {
        pair.casing.bringToFront();
        pair.poly.bringToFront();
      }
    }
    // The live track must never be buried under a course trace.
    if (drawn.trackLine) drawn.trackLine.bringToFront();
    if (drawn.head && drawn.head.setZIndexOffset) drawn.head.setZIndexOffset(1000);
  }

  /** Checkbox per stage, the way a layered map lets you peel routes apart. */
  function buildLegend() {
    const box = $('layers');
    if (!box) return;
    box.innerHTML = '';

    for (const s of CFG.stages) {
      const id = `layer-${s.n}`;
      const row = document.createElement('label');
      row.className = 'layer';
      row.innerHTML = `
        <input type="checkbox" id="${id}" checked>
        <span class="layer__swatch" style="background:${s.color}"></span>
        <span class="layer__name">${s.n} · ${s.name}</span>
        <span class="layer__mi">${s.miles}</span>
      `;
      row.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) shown.add(s.n);
        else shown.delete(s.n);
        applyStageStyles();
        syncLegendAll();
      });
      box.appendChild(row);
    }

    const all = $('layers-all');
    if (all) {
      all.addEventListener('change', () => {
        CFG.stages.forEach((s) => {
          const cb = $(`layer-${s.n}`);
          if (cb) cb.checked = all.checked;
          if (all.checked) shown.add(s.n);
          else shown.delete(s.n);
        });
        applyStageStyles();
      });
    }
  }

  function syncLegendAll() {
    const all = $('layers-all');
    if (!all) return;
    all.checked = shown.size === CFG.stages.length;
    all.indeterminate = shown.size > 0 && shown.size < CFG.stages.length;
  }

  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView(
      [39.4817, -106.0384],
      12
    );

    layers.topo = L.tileLayer(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 16, attribution: 'USGS The National Map' }
    );
    layers.imagery = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 18, attribution: 'Esri, Maxar, Earthstar Geographics' }
    );
    layers.topo.addTo(map);

    // A tile server having a bad night should say so, not just look like a
    // blank map that might mean anything.
    [layers.topo, layers.imagery].forEach((l) =>
      l.on('tileerror', () => {
        if (++tileErrors === 12) note('Basemap tiles are failing. The track below is still current.');
      })
    );

    layers.courses = L.layerGroup().addTo(map);
    layers.marks = L.layerGroup().addTo(map);
    layers.track = L.layerGroup().addTo(map);

    document.querySelectorAll('.basemap-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const want = btn.dataset.basemap;
        Object.entries({ topo: layers.topo, imagery: layers.imagery }).forEach(([k, layer]) => {
          if (k === want) layer.addTo(map);
          else map.removeLayer(layer);
        });
        document
          .querySelectorAll('.basemap-toggle button')
          .forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });
  }

  /* ---------- course overlay ---------- */

  async function loadCourses() {
    const bounds = [];

    for (const stage of CFG.stages) {
      try {
        const res = await fetch(`courses/stage-${stage.n}.geojson`, { cache: 'force-cache' });
        if (!res.ok) continue;
        const geo = await res.json();
        const line = geo.geometry.coordinates.map((c) => [c[1], c[0]]);
        if (line.length < 2) continue;

        // A casing under each trace. Six coloured lines crossing each other on
        // a busy topo need separating from the basemap as well as from each
        // other, and this is how a printed map does it.
        const casing = L.polyline(line, {
          color: '#EDE4D3',
          weight: 6,
          opacity: 0.55,
          lineJoin: 'round',
        }).addTo(layers.courses);

        const poly = L.polyline(line, {
          color: stage.color || '#6E4A26',
          weight: 3,
          opacity: 0.9,
          lineJoin: 'round',
        })
          .bindTooltip(`Stage ${stage.n} — ${stage.name}`, { sticky: true })
          .addTo(layers.courses);

        stagePolys[stage.n] = { poly, casing };
        bounds.push(...line);
      } catch (_) {
        /* a missing course file just means no underlay for that stage */
      }
    }

    try {
      const res = await fetch('courses/course-index.json', { cache: 'force-cache' });
      if (res.ok) {
        const idx = await res.json();
        course.lon = idx.lon;
        course.lat = idx.lat;
        course.cumMiles = idx.cumMiles;
        course.stageSpans = idx.stageSpans || [];
        course.totalMiles = idx.totalMiles || CFG.totalMiles;
        course.loaded = Array.isArray(idx.lon) && idx.lon.length > 1;
        planCurve = buildPlanCurve();
        // Anything resolved before this point was resolved without a course.
        mileCache.clear();
      }
    } catch (_) {
      /* without the index there is no snapping; everything else still works */
    }

    try {
      const res = await fetch('courses/markers.geojson', { cache: 'force-cache' });
      if (res.ok) {
        const geo = await res.json();
        // Mileage comes from the build, where each marker is resolved inside
        // its own stage. Snapping here instead would put stage 1 landmarks a
        // hundred miles downcourse wherever the route revisits ground.
        course.markers = geo.features.map((f) => {
          const [lon, lat] = f.geometry.coordinates;
          return {
            title: f.properties.title,
            kind: f.properties.kind,
            climb: !!f.properties.climb,
            stage: f.properties.stage,
            lat,
            lon,
            mile: Number.isFinite(f.properties.mile) ? f.properties.mile : null,
          };
        });
        drawMarkers();
      }
    } catch (_) {
      /* markers are enrichment, not load-bearing */
    }

    if (bounds.length && !hasFitBounds) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.06));
      hasFitBounds = true;
    }
  }

  function drawMarkers() {
    for (const m of course.markers) {
      const isCrossing = m.kind === 'crossing';
      const isWater = m.kind === 'water';
      L.circleMarker([m.lat, m.lon], {
        radius: isCrossing || isWater ? 3.5 : 4,
        color: isWater ? '#2E6E8E' : isCrossing ? '#8A6A3B' : '#4A6B3A',
        weight: 1.5,
        fillColor: '#EDE4D3',
        fillOpacity: 1,
      })
        .bindTooltip(m.title, { direction: 'top' })
        .addTo(layers.marks);
    }
  }

  /* ---------- live track ---------- */

  function drawTrack(fixes) {
    if (!fixes.length) return;
    const line = fixes.map((p) => [p.lat, p.lon]);

    // Reuse layers rather than clearing and rebuilding. This page is meant to
    // sit open for twenty hours; tearing down hundreds of markers every minute
    // is how a tab ends up using a gigabyte.
    if (!drawn.trackLine) {
      drawn.trackLine = L.polyline(line, { color: '#BF3B2B', weight: 3, opacity: 0.95 }).addTo(layers.track);
    } else {
      drawn.trackLine.setLatLngs(line);
    }

    // Per-fix dots only change when a fix arrives, so only rebuild then.
    if (drawn.dotsFor !== fixes.length) {
      layers.track.clearLayers();
      drawn.trackLine.addTo(layers.track);
      fixes.forEach((p, i) => {
        if (i === fixes.length - 1) return;
        L.circleMarker([p.lat, p.lon], {
          radius: 3,
          color: '#BF3B2B',
          weight: 1,
          fillColor: '#EDE4D3',
          fillOpacity: 1,
        })
          .bindTooltip(`${clockFmt.format(new Date(p.t * 1000))} · ${p.type}`)
          .addTo(layers.track);
      });
      drawn.dotsFor = fixes.length;
      drawn.head = null;
    }

    const last = fixes[fixes.length - 1];
    if (!drawn.head) {
      drawn.head = L.marker([last.lat, last.lon], {
        icon: L.divIcon({ className: '', html: '<div class="head-marker"></div>', iconSize: [16, 16] }),
        zIndexOffset: 1000,
      }).addTo(layers.track);
    } else {
      drawn.head.setLatLng([last.lat, last.lon]);
    }
    drawn.head.bindTooltip(`${CFG.rider} · ${clockFmt.format(new Date(last.t * 1000))}`);

    if (!hasFitBounds) {
      map.fitBounds(L.latLngBounds(line).pad(0.15));
      hasFitBounds = true;
    }
  }

  /* ---------- readouts ---------- */

  function setStatusBar(age, where, mile, stale) {
    const a = $('sb-age');
    if (!a) return;
    a.textContent = age;
    $('sb-where').textContent = where;
    $('sb-mile').textContent = mile;
    $('statusbar').classList.toggle('is-stale', !!stale);
  }

  function note(text) {
    const el = $('notice');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  function renderPings(fixes, now) {
    const row = $('ping-row');
    row.innerHTML = '';
    for (let i = PING_SLOTS - 1; i >= 0; i--) {
      const hi = now - i * PING_MS;
      const lo = hi - PING_MS;
      const hit = fixes.some((p) => p.t * 1000 > lo && p.t * 1000 <= hi);
      const el = document.createElement('div');
      el.className = 'ping' + (hit ? ' is-hit' : '') + (i === 0 && hit ? ' is-latest' : '');
      row.appendChild(el);
    }
  }

  function renderCourseReadout(snap, fixes, ageText, stale) {
    const where = $('where');
    const whereSub = $('where-sub');
    const progress = $('progress');
    const progressSub = $('progress-sub');
    if (!where) return;

    if (!snap) {
      where.textContent = '—';
      whereSub.textContent = course.loaded ? 'No fix yet' : 'Course data unavailable';
      progress.textContent = '—';
      progressSub.textContent = `of ${course.totalMiles.toFixed(0)} mi`;
      setStatusBar('—', '—', '—');
      emphasiseStage(null);
      return;
    }
    emphasiseStage(snap.onCourse && !snap.transfer ? snap.stage : null);

    // Before the gun, any fix is him wandering around Breckenridge, and
    // reporting it as a course position — "Transferring", a stage, a mileage —
    // is confidently wrong. This is the state the page sits in for the whole
    // day before the start, so it is the state most people will see first.
    if (Date.now() < START_MS) {
      where.textContent = 'Not started';
      whereSub.textContent = `Starts ${clockFmt.format(new Date(START_MS))}`;
      progress.textContent = '—';
      progressSub.textContent = `of ${course.totalMiles.toFixed(0)} mi`;
      renderPlan(null);
      setStatusBar(ageText, 'Not started', '—', false);
      return;
    }

    if (!snap.onCourse) {
      where.textContent = 'Off course';
      whereSub.textContent = `${snap.offMiles.toFixed(1)} mi from the route`;
    } else if (snap.transfer) {
      // The schedule says he should be off the bike here. Name the break.
      const sc = snap.scheduled || {};
      where.textContent = sc.label || 'Between stages';
      whereSub.textContent = sc.kind === 'sleep' ? 'Scheduled sleep' : 'Scheduled stop';
    } else {
      const feat = featureAt(snap.mile);
      where.textContent = feat ? feat.title : `Stage ${snap.stage}`;
      whereSub.textContent = feat ? `Stage ${snap.stage} · ${snap.stageName}` : snap.stageName;
    }

    if (snap.onCourse) {
      // Gold Dust finishes back at the Ice Rink and the course runs close to
      // itself for the last few miles, so the snap can wobble by a mile there.
      // The stages are ridden in sequence, so reported progress only advances.
      // A genuine detour still shows, as "Off course".
      maxMileSeen = Math.max(maxMileSeen, snap.mile);
      progress.textContent = `${maxMileSeen.toFixed(1)} mi`;
      const pct = Math.round((maxMileSeen / course.totalMiles) * 100);
      progressSub.textContent = `of ${course.totalMiles.toFixed(0)} mi · ${pct}%`;
    } else {
      progress.textContent = '—';
      progressSub.textContent = 'off course';
    }

    renderPlan(snap);

    // Nearest point a crew vehicle could reach, with a rough ETA from the
    // pace over the last few hours rather than an average over the whole ride.
    const crew = $('crew');
    const crewSub = $('crew-sub');
    if (crew) {
      const nx = snap.onCourse ? nextCrossing(snap.mile) : null;
      if (!nx) {
        crew.textContent = 'None mapped';
        // The official route data only carries markers for stages 1-3, so past
        // roughly mile 78 there is nothing to point at. Saying "no crossing
        // ahead" would imply the course has no road access, which is wrong and
        // exactly the sort of thing a crew would act on.
        crewSub.textContent = hasCrossingsBeyond(snap.mile)
          ? 'No crossing ahead'
          : 'Route data has no markers past stage 3';
      } else {
        const away = nx.mile - snap.mile;
        const mph = recentPace(fixes);
        crew.textContent = nx.title;
        crewSub.textContent = mph
          ? `${away.toFixed(1)} mi · ~${timeOnlyFmt.format(new Date(Date.now() + (away / mph) * 3600000))}`
          : `${away.toFixed(1)} mi ahead`;
      }
    }

    setStatusBar(ageText, where.textContent, progress.textContent, stale);
  }

  function renderPlan(snap) {
    const el = $('plan');
    const sub = $('plan-sub');
    if (!el) return;

    const elapsedH = (Date.now() - START_MS) / 3600000;
    if (!planCurve || !snap || !snap.onCourse || elapsedH < 0) {
      el.textContent = '—';
      sub.textContent = planCurve ? 'Not started' : 'Schedule unavailable';
      el.classList.remove('is-behind', 'is-ahead');
      return;
    }

    const shouldHaveTakenH = plannedHoursAtMile(snap.mile);
    const deltaH = elapsedH - shouldHaveTakenH; // positive = behind
    const planMile = plannedMileAtHours(elapsedH);

    const behind = deltaH > 0;
    const mag = hhmm(Math.abs(deltaH) * 3600000);
    // Under twenty minutes either way is noise on a 58-hour effort.
    if (Math.abs(deltaH) < 1 / 3) {
      el.textContent = 'On plan';
      el.classList.remove('is-behind', 'is-ahead');
    } else {
      el.textContent = `${mag} ${behind ? 'behind' : 'ahead'}`;
      el.classList.toggle('is-behind', behind);
      el.classList.toggle('is-ahead', !behind);
    }
    sub.textContent = `plan says mile ${planMile.toFixed(1)}`;
  }

  /** Miles per hour over the last two hours of fixes, or null if too few. */
  function recentPace(fixes) {
    const cutoff = Date.now() / 1000 - 2 * 3600;
    const recent = fixes.filter((p) => p.t >= cutoff);
    if (recent.length < 3) return null;
    let miles = 0;
    for (let i = 1; i < recent.length; i++) miles += haversineMiles(recent[i - 1], recent[i]);
    const hours = (recent[recent.length - 1].t - recent[0].t) / 3600;
    if (hours <= 0.25 || miles < 0.5) return null;
    return miles / hours;
  }

  function renderStats(points, status) {
    const now = Date.now();
    const fixes = points.filter((p) => p.positioned);

    $('fix-count').textContent = `${fixes.length} ${fixes.length === 1 ? 'fix' : 'fixes'} on file`;

    // Pipeline health is separate from rider silence. A stale heartbeat means
    // the page cannot vouch for anything below it, which is worth saying out
    // loud rather than showing an old dot as though it were current.
    const health = $('health');
    if (health) {
      const polledAt = status && status.polledAt ? Date.parse(status.polledAt) : NaN;
      if (!status) {
        health.hidden = false;
        health.className = 'health is-warn';
        health.textContent = 'Cannot read the poller heartbeat. Positions below may be out of date.';
      } else if (Number.isFinite(polledAt) && now - polledAt > POLLER_STALE_MS) {
        health.hidden = false;
        health.className = 'health is-warn';
        health.textContent = `Tracker pipeline last ran ${ago(now - polledAt)} ago. Nothing below is confirmed current.`;
      } else if (status.ok === false) {
        health.hidden = false;
        health.className = 'health is-warn';
        health.textContent = `Last poll failed: ${status.error || 'unknown error'}. Showing the last good data.`;
      } else {
        health.hidden = true;
      }
    }

    if (!fixes.length) {
      $('map-empty').hidden = false;
      $('map-empty').textContent =
        now < START_MS ? 'Waiting on the first fix.' : 'No positions received yet.';
      $('fix-age').textContent = '—';
      $('fix-time').textContent =
        now < START_MS ? `Starts ${clockFmt.format(new Date(START_MS))}` : 'No data yet';
      $('elapsed').textContent = now < START_MS ? '—' : hhmm(now - START_MS);
      $('distance').textContent = '—';
      $('position').textContent = '—';
      renderPings([], now);
      renderCourseReadout(null, [], '—', false);
      document.querySelector('.readout--hero').classList.remove('is-stale');
      return;
    }

    $('map-empty').hidden = true;

    const last = fixes[fixes.length - 1];
    const lastMs = last.t * 1000;
    const age = now - lastMs;

    $('fix-age').textContent = ago(age);
    document.querySelector('.readout--hero').classList.toggle('is-stale', age > STALE_MS);

    // Fix time, and whether he has been sitting still. A stop is normal and
    // often planned; saying so stops a cluster of identical fixes reading as a
    // fault.
    const move = movementState(fixes, now);
    const at = clockFmt.format(new Date(lastMs));
    if (move && !move.moving) {
      $('fix-time').textContent = `${at} · stopped ${hhmm(move.ageMs)}`;
    } else {
      $('fix-time').textContent = at;
    }

    $('elapsed').textContent = now < START_MS ? '—' : hhmm(now - START_MS);
    $('elapsed-sub').textContent = `of ${CFG.targetHours} h target`;

    let miles = 0;
    for (let i = 1; i < fixes.length; i++) miles += haversineMiles(fixes[i - 1], fixes[i]);
    $('distance').textContent = `${miles.toFixed(1)} mi`;

    $('position').textContent = `${last.lat.toFixed(5)}, ${last.lon.toFixed(5)}`;

    renderPings(fixes, now);
    // The headline comes from the same walk the rail uses, so the two can
    // never disagree about which stage he is on.
    renderCourseReadout(currentFromWalk(fixes), fixes, ago(age), age > STALE_MS);

    const help = [...points].reverse().find((p) => p.type === 'HELP');
    const cancelled = points.some((p) => p.type === 'HELP-CANCEL' && help && p.t > help.t);
    const alert = $('alert');
    if (help && !cancelled) {
      alert.hidden = false;
      alert.textContent = `HELP sent at ${clockFmt.format(new Date(help.t * 1000))}. Call the crew.`;
    } else {
      alert.hidden = true;
    }
  }

  const LABELS = { todo: 'To do', active: 'In progress', done: 'Complete' };

  /**
   * Each stage box is shaped by its state, because the three states answer
   * different questions. A finished stage is a result; the one he is on is a
   * clock; the ones ahead are a forecast.
   */
  function renderRail(fixes) {
    const list = $('stage-rail');
    list.innerHTML = '';

    const statuses = stageStatuses(fixes || []);
    // Before the start, or with no course data, everything is simply ahead.
    const fallback = !statuses.length;

    CFG.stages.forEach((s, i) => {
      const st = fallback ? { stage: s, state: 'todo' } : statuses[i];
      const li = document.createElement('li');
      li.className = `stage is-${st.state}`;
      li.style.setProperty('--stage-color', s.color || 'var(--contour-deep)');

      let body;
      if (st.state === 'done') {
        body = `
          <p class="stage__figure">${st.durationMs != null ? hhmm(st.durationMs) : '—'}</p>
          <p class="stage__figlabel">elapsed for stage</p>
          <p class="stage__time">finished ${clockFmt.format(new Date(st.finishedT * 1000))}</p>`;
      } else if (st.state === 'active') {
        const pct = Math.min(100, Math.round((st.milesIn / st.milesTotal) * 100));
        body = `
          <p class="stage__figure">${hhmm(st.runningMs)}</p>
          <p class="stage__figlabel">on this stage</p>
          <p class="stage__time">${st.milesIn.toFixed(1)} of ${st.milesTotal.toFixed(1)} mi</p>
          <div class="stage__bar"><span style="width:${pct}%"></span></div>`;
      } else {
        const eta = st.etaStartMs
          ? clockFmt.format(new Date(st.etaStartMs))
          : clockFmt.format(new Date(START_MS + s.startOffsetHours * 3600000));
        body = `
          <p class="stage__figure stage__figure--sm">${eta}</p>
          <p class="stage__figlabel">${st.shifted ? 'projected start' : 'planned start'}</p>
          <p class="stage__time">${hhmm(s.durationHours * 3600000)} estimated</p>`;
      }

      li.innerHTML = `
        <p class="stage__n">${s.n}</p>
        <p class="stage__status">${LABELS[st.state]}</p>
        <p class="stage__name">${s.name}</p>
        <p class="stage__leg">${s.from} → ${s.to}</p>
        <p class="stage__num">${s.miles} mi · ${s.gain.toLocaleString()}${s.gainEstimated ? '~' : ''} ft</p>
        ${body}
        ${s.note ? `<p class="stage__note">${s.note}</p>` : ''}
      `;
      list.appendChild(li);
    });
  }

  /* ---------- boot ---------- */

  let consecutiveFailures = 0;

  async function readJson(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
  }

  async function refresh() {
    let status = null;
    try {
      status = await readJson('data/status.json');
    } catch (_) {
      /* the heartbeat is allowed to be missing; renderStats says so */
    }

    try {
      const data = await readJson('data/track.json');
      const points = Array.isArray(data.points) ? data.points : [];
      const fixes = points.filter((p) => p.positioned);
      consecutiveFailures = 0;
      drawTrack(fixes);
      // The rail walks and caches every fix, so run it first: the headline
      // readout then has a resolved previous mileage to be continuous with.
      renderRail(fixes);
      renderStats(points, status);
      note('');
      return;
    } catch (err) {
      consecutiveFailures++;
      // One failed fetch is a blip. Several in a row means the page is showing
      // something it can no longer stand behind, and should say so.
      if (consecutiveFailures >= 2) {
        note(`Cannot reach the track data (${consecutiveFailures} attempts). Positions shown may be old.`);
        $('map-empty').hidden = false;
        $('map-empty').textContent = 'Track data unavailable. Retrying.';
      }
    }
    renderRail([]);
  }

  function init() {
    $('race-title').textContent = CFG.title;
    $('race-subtitle').textContent = CFG.subtitle;
    $('meta-distance').textContent = `${CFG.totalMiles} mi`;
    $('meta-start').textContent = fullDateFmt.format(new Date(START_MS));
    document.title = `${CFG.title} · Live Track`;

    initMap();
    buildLegend();
    loadCourses().then(refresh);
    refresh();

    setInterval(() => {
      // A backgrounded tab does not need to redraw. It refreshes on return.
      if (document.visibilityState === 'visible') refresh();
    }, CFG.refreshSeconds * 1000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
