/* global L */
/**
 * Race replay.
 *
 * Drives the same map and course data as the tracker from a scrubber instead
 * of from the clock. The interesting problem is not playback — it is that the
 * fixes are sparse and uneven: 192 positions across 57 hours, 25 gaps longer
 * than twenty minutes and one of nearly five. Stepping between them makes the
 * rider teleport.
 *
 * So position is interpolated along the course line rather than between fixes.
 * Each fix is snapped to a mileage, mileage is interpolated over time, and the
 * mileage is mapped back onto the route. The dot then rides the actual trail
 * through the gaps at a plausible speed.
 *
 * That is inference, not measurement, and the page says so: interpolated
 * stretches are drawn differently and the readout names them.
 */
(function () {
  'use strict';

  const CFG = window.RACE_CONFIG;
  const $ = (id) => document.getElementById(id);

  const START_MS = Date.parse('2026-08-12T15:00:00Z'); // 09:00 MDT
  let endMs = null;

  // Beyond this a straight line between fixes is not credible, and the course
  // is the better guess. Below it, trust the fixes as recorded.
  const INTERP_ABOVE_MIN = 12;
  const OFF_COURSE_MILES = 0.5;

  const state = {
    t: START_MS,
    playing: false,
    speed: 900, // race-seconds per real second
    raf: null,
    last: null,
  };

  const course = { lon: null, lat: null, cumMiles: null, stageSpans: [], totalMiles: 216 };
  let fixes = [];
  let samples = []; // { t, mile, lat, lon, onCourse, interpolated }
  let override = null;

  /* ---------- geometry ---------- */

  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const LAT_S = R * (Math.PI / 180);
  const LON_S = LAT_S * Math.cos(toRad(39.5));

  /**
   * Nearest point on the route, optionally restricted to a mileage window.
   *
   * The window is not an optimisation, it is the whole correctness argument.
   * The course crosses itself constantly and returns to Breckenridge six
   * times, so a global search puts a fix from hour 23 at mile 190. Searching
   * forward from where he already was is what makes the answer unique.
   */
  const haversine = (a, b) => {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(a.lon - b.lon);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  function snapMile(lat, lon, loMile, hiMile) {
    const { lon: xs, lat: ys, cumMiles } = course;
    const px = lon * LON_S;
    const py = lat * LAT_S;
    let bestD = Infinity;
    let bestMile = null;
    for (let i = 1; i < xs.length; i++) {
      if (loMile != null && cumMiles[i] < loMile) continue;
      if (hiMile != null && cumMiles[i - 1] > hiMile) break;
      const ax = xs[i - 1] * LON_S, ay = ys[i - 1] * LAT_S;
      const bx = xs[i] * LON_S, by = ys[i] * LAT_S;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = 0;
      if (l2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < bestD) {
        bestD = d;
        bestMile = cumMiles[i - 1] + t * (cumMiles[i] - cumMiles[i - 1]);
      }
    }
    return { mile: bestMile, off: bestD };
  }

  /** Mileage back to a position on the route. */
  function atMile(m) {
    const c = course.cumMiles;
    const clamped = Math.max(0, Math.min(m, c[c.length - 1]));
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= clamped) lo = mid;
      else hi = mid;
    }
    const span = c[hi] - c[lo] || 1;
    const f = (clamped - c[lo]) / span;
    return [course.lat[lo] + f * (course.lat[hi] - course.lat[lo]), course.lon[lo] + f * (course.lon[hi] - course.lon[lo])];
  }

  /* ---------- build the timeline ---------- */

  function buildSamples() {
    // Snap every fix once. Continuity matters: the course crosses itself
    // constantly, so a fix is resolved forward from the previous mileage
    // rather than to the globally nearest point.
    let prev = null;
    let prevFix = null;

    return fixes.map((f) => {
      const movedMi = prevFix ? haversine(prevFix, f) : 0;

      // Standing still cannot advance the route. Without this the house — which
      // sits within half a mile of the course at miles 37, 114 and 155 — pulls
      // a stationary fix a hundred miles up-course during the rests, and the
      // replay shows him finishing while he is asleep.
      if (prevFix && movedMi < 0.15 && prev != null) {
        prevFix = f;
        return { t: f.t * 1000, lat: f.lat, lon: f.lon, mile: prev, onCourse: true, stopped: true };
      }

      // He can only have advanced along the route as far as he has moved
      // across the ground, times a generous allowance for switchbacks. That
      // bound is what keeps the search unique where the course doubles back.
      const reach = Math.max(3, movedMi * 3 + 2);
      const s =
        prev == null
          ? snapMile(f.lat, f.lon, 0, 40)
          : snapMile(f.lat, f.lon, Math.max(0, prev - 1), prev + reach);

      const onCourse = s.mile != null && s.off <= OFF_COURSE_MILES;
      if (onCourse) prev = s.mile;
      prevFix = f;
      return { t: f.t * 1000, lat: f.lat, lon: f.lon, mile: onCourse ? s.mile : prev, onCourse, off: s.off };
    });
  }

  /** Position at an arbitrary instant, interpolated along the route. */
  function positionAt(ms) {
    if (!samples.length) return null;
    if (ms <= samples[0].t) return { ...samples[0], interpolated: false };

    let i = 0;
    while (i < samples.length - 1 && samples[i + 1].t <= ms) i++;
    const a = samples[i];
    const b = samples[i + 1];
    if (!b) return { ...a, interpolated: false, stale: ms - a.t };

    const gapMin = (b.t - a.t) / 60000;
    const f = (ms - a.t) / (b.t - a.t);

    // Short gap, or either end off the route: straight line between the two
    // recorded points. Honest, and over a few minutes indistinguishable.
    if (gapMin < INTERP_ABOVE_MIN || !a.onCourse || !b.onCourse || a.mile == null || b.mile == null) {
      return {
        t: ms,
        lat: a.lat + f * (b.lat - a.lat),
        lon: a.lon + f * (b.lon - a.lon),
        mile: a.mile != null && b.mile != null ? a.mile + f * (b.mile - a.mile) : a.mile,
        onCourse: a.onCourse && b.onCourse,
        interpolated: gapMin >= INTERP_ABOVE_MIN,
      };
    }

    // Long gap between two on-course fixes: ride the route between them.
    const mile = a.mile + f * (b.mile - a.mile);
    const [lat, lon] = atMile(mile);
    return { t: ms, lat, lon, mile, onCourse: true, interpolated: true, gapMin };
  }

  /** The trail drawn so far, following the route through long gaps. */
  function trailTo(ms) {
    const pts = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.t > ms) break;
      const next = samples[i + 1];
      pts.push([s.lat, s.lon]);
      if (next && next.t <= ms && s.onCourse && next.onCourse && s.mile != null && next.mile != null) {
        const gapMin = (next.t - s.t) / 60000;
        if (gapMin >= INTERP_ABOVE_MIN) {
          // Fill the gap with the route itself rather than a chord across it.
          const steps = Math.min(60, Math.max(4, Math.round(Math.abs(next.mile - s.mile) * 3)));
          for (let k = 1; k < steps; k++) {
            pts.push(atMile(s.mile + ((next.mile - s.mile) * k) / steps));
          }
        }
      }
    }
    const head = positionAt(ms);
    if (head) pts.push([head.lat, head.lon]);
    return pts;
  }

  /* ---------- map ---------- */

  let map;
  let trail;
  let head;
  const stagePolys = {};

  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([39.4817, -106.0384], 11);
    L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16,
      attribution: 'USGS The National Map',
    }).addTo(map);
    trail = L.polyline([], { color: '#BF3B2B', weight: 2.6, opacity: 0.85 }).addTo(map);
    head = L.marker([39.4817, -106.0384], {
      icon: L.divIcon({ className: '', html: '<div class="head-marker"></div>', iconSize: [16, 16] }),
      zIndexOffset: 1000,
    }).addTo(map);
  }

  async function loadCourses() {
    const bounds = [];
    for (const s of CFG.stages) {
      try {
        const r = await fetch(`courses/stage-${s.n}.geojson`, { cache: 'force-cache' });
        if (!r.ok) continue;
        const g = await r.json();
        const line = g.geometry.coordinates.map((c) => [c[1], c[0]]);
        stagePolys[s.n] = L.polyline(line, { color: s.color, weight: 2, opacity: 0.35 }).addTo(map);
        bounds.push(...line);
      } catch (_) { /* a stage without a file simply is not drawn */ }
    }
    if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.05));
  }

  /* ---------- readouts ---------- */

  const fmtClock = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
  });
  const hhmm = (ms) => {
    const t = Math.max(0, Math.floor(ms / 60000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };

  function stageAt(mile) {
    if (mile == null) return null;
    return course.stageSpans.find((s) => mile >= s.startMile && mile <= s.endMile) || null;
  }

  function render() {
    const ms = state.t;
    const pos = positionAt(ms);
    $('r-clock').textContent = fmtClock.format(new Date(ms));
    $('r-elapsed').textContent = hhmm(ms - START_MS);

    if (!pos) return;

    head.setLatLng([pos.lat, pos.lon]);
    trail.setLatLngs(trailTo(ms));

    const st = stageAt(pos.mile);
    $('r-stage').textContent = st ? `Stage ${st.stage} · ${st.name}` : 'Between stages';
    $('r-mile').textContent = pos.mile != null ? `${pos.mile.toFixed(1)} mi` : '—';
    $('r-pct').textContent = pos.mile != null ? `${Math.round((pos.mile / course.totalMiles) * 100)}%` : '';

    // Say plainly when the dot is being inferred rather than recorded.
    const note = $('r-note');
    if (pos.interpolated) {
      note.textContent = `No fix for ${Math.round(pos.gapMin || 0)} min — position estimated along the course`;
      note.hidden = false;
      trail.setStyle({ dashArray: '6 5' });
    } else {
      note.hidden = true;
      trail.setStyle({ dashArray: null });
    }

    for (const [n, poly] of Object.entries(stagePolys)) {
      const active = st && Number(n) === st.stage;
      poly.setStyle({ opacity: active ? 0.85 : 0.28, weight: active ? 3 : 2 });
    }

    const pct = (ms - START_MS) / (endMs - START_MS);
    $('r-scrub').value = String(Math.round(pct * 1000));
    $('r-fill').style.width = `${pct * 100}%`;
  }

  /* ---------- transport ---------- */

  function tick(now) {
    if (!state.playing) return;
    if (state.last == null) state.last = now;
    const dt = (now - state.last) / 1000;
    state.last = now;
    state.t += dt * state.speed * 1000;
    if (state.t >= endMs) {
      state.t = endMs;
      pause();
      render();
      return;
    }
    render();
    state.raf = requestAnimationFrame(tick);
  }

  function play() {
    if (state.t >= endMs) state.t = START_MS;
    state.playing = true;
    state.last = null;
    $('r-play').textContent = '❚❚';
    $('r-play').setAttribute('aria-label', 'Pause');
    state.raf = requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    $('r-play').textContent = '▶';
    $('r-play').setAttribute('aria-label', 'Play');
  }

  function seek(ms) {
    state.t = Math.max(START_MS, Math.min(ms, endMs));
    state.last = null;
    render();
  }

  /* ---------- boot ---------- */

  async function init() {
    const [idx, track, ov] = await Promise.all([
      fetch('courses/course-index.json').then((r) => r.json()),
      fetch('data/track.json').then((r) => r.json()),
      fetch('data/override.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    course.lon = idx.lon;
    course.lat = idx.lat;
    course.cumMiles = idx.cumMiles;
    course.stageSpans = idx.stageSpans || [];
    course.totalMiles = idx.totalMiles || 216;
    override = ov;

    endMs = ov && ov.raceFinishedAt ? Date.parse(ov.raceFinishedAt) : Date.now();

    fixes = (track.points || [])
      .filter((p) => p.positioned && p.t * 1000 >= START_MS && p.t * 1000 <= endMs)
      .sort((a, b) => a.t - b.t);

    initMap();
    await loadCourses();
    samples = buildSamples();

    buildTimelineBands();
    $('r-total').textContent = hhmm(endMs - START_MS);
    $('r-fixes').textContent = `${fixes.length} fixes`;

    $('r-play').addEventListener('click', () => (state.playing ? pause() : play()));
    $('r-restart').addEventListener('click', () => { pause(); seek(START_MS); });
    $('r-back').addEventListener('click', () => seek(state.t - 30 * 60000));
    $('r-fwd').addEventListener('click', () => seek(state.t + 30 * 60000));
    $('r-scrub').addEventListener('input', (e) => {
      pause();
      seek(START_MS + (Number(e.target.value) / 1000) * (endMs - START_MS));
    });
    document.querySelectorAll('.speed button').forEach((b) => {
      b.addEventListener('click', () => {
        state.speed = Number(b.dataset.speed);
        document.querySelectorAll('.speed button').forEach((x) => x.classList.toggle('is-active', x === b));
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
      if (e.code === 'ArrowLeft') seek(state.t - 30 * 60000);
      if (e.code === 'ArrowRight') seek(state.t + 30 * 60000);
    });

    seek(START_MS);
  }

  /** Stage bands and the two nights, drawn under the scrubber. */
  function buildTimelineBands() {
    const bar = $('r-bands');
    if (!bar || !override) return;
    const total = endMs - START_MS;
    for (const s of CFG.stages) {
      const a = (override.starts || {})[String(s.n)];
      const b = (override.finishes || {})[String(s.n)];
      if (!a || !b) continue;
      const x = ((Date.parse(a) - START_MS) / total) * 100;
      const w = ((Date.parse(b) - Date.parse(a)) / total) * 100;
      const el = document.createElement('div');
      el.className = 'band';
      el.style.cssText = `left:${x}%;width:${w}%;background:${s.color}`;
      el.title = `Stage ${s.n} — ${s.name}`;
      bar.appendChild(el);
    }
    // Night, so the two dark stretches he rode through are visible at a glance.
    for (const [from, to] of [['2026-08-12T20:15:00-06:00', '2026-08-13T06:15:00-06:00'],
                              ['2026-08-13T20:15:00-06:00', '2026-08-14T06:15:00-06:00']]) {
      const x = ((Date.parse(from) - START_MS) / total) * 100;
      const w = ((Date.parse(to) - Date.parse(from)) / total) * 100;
      const el = document.createElement('div');
      el.className = 'night';
      el.style.cssText = `left:${Math.max(0, x)}%;width:${w}%`;
      bar.appendChild(el);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
