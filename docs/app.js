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

  /**
   * Nearest point on the course to a fix. Returns the along-course mileage,
   * how far off the line it is, and which stage that mileage falls in.
   *
   * This is what makes "he is on the Georgia Pass climb" possible instead of
   * "he is at 39.48, -105.94", and it is why the distance readout can be real
   * course distance rather than straight lines between ten-minute samples.
   */
  function snapToCourse(lat, lon) {
    if (!course.loaded) return null;
    const { lon: xs, lat: ys, cumMiles } = course;
    const py = lat * LAT_SCALE;
    const px = lon * LON_SCALE;

    let bestD2 = Infinity;
    let bestMile = 0;

    for (let i = 1; i < xs.length; i++) {
      const ax = xs[i - 1] * LON_SCALE, ay = ys[i - 1] * LAT_SCALE;
      const bx = xs[i] * LON_SCALE, by = ys[i] * LAT_SCALE;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = 0;
      if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestMile = cumMiles[i - 1] + t * (cumMiles[i] - cumMiles[i - 1]);
      }
    }

    const offMiles = Math.sqrt(bestD2);
    const onCourse = offMiles <= OFF_COURSE_MILES;
    const span = course.stageSpans.find((s) => bestMile >= s.startMile && bestMile <= s.endMile);
    return {
      mile: bestMile,
      offMiles,
      onCourse,
      stage: span ? span.stage : null,
      stageName: span ? span.name : null,
      // Between a stage finish and the next start he is transferring, which is
      // a real state and not an error.
      transfer: !span,
    };
  }

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

  /**
   * Six overlapping stage lines at equal weight is a plate of spaghetti. Lift
   * the stage he is actually on and let the rest recede to context.
   */
  function emphasiseStage(n) {
    if (n === emphasised) return;
    emphasised = n;
    for (const [k, poly] of Object.entries(stagePolys)) {
      const active = Number(k) === n;
      poly.setStyle({
        opacity: n == null ? 0.45 : active ? 0.9 : 0.22,
        weight: active ? 3.5 : 2.5,
        color: active ? '#4A6B3A' : '#6E4A26',
      });
      if (active) poly.bringToFront();
    }
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

        const poly = L.polyline(line, {
          color: '#6E4A26',
          weight: 2.5,
          opacity: 0.45,
          lineJoin: 'round',
        })
          .bindTooltip(`Stage ${stage.n} — ${stage.name}`, { sticky: true })
          .addTo(layers.courses);
        stagePolys[stage.n] = poly;
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

    if (!snap.onCourse) {
      where.textContent = 'Off course';
      whereSub.textContent = `${snap.offMiles.toFixed(1)} mi from the route`;
    } else if (snap.transfer) {
      where.textContent = 'Transferring';
      whereSub.textContent = 'Between stages';
    } else {
      const feat = featureAt(snap.mile);
      where.textContent = feat ? feat.title : `Stage ${snap.stage}`;
      whereSub.textContent = feat ? `Stage ${snap.stage} · ${snap.stageName}` : snap.stageName;
    }

    if (snap.onCourse) {
      progress.textContent = `${snap.mile.toFixed(1)} mi`;
      const pct = Math.round((snap.mile / course.totalMiles) * 100);
      progressSub.textContent = `of ${course.totalMiles.toFixed(0)} mi · ${pct}%`;
    } else {
      progress.textContent = '—';
      progressSub.textContent = 'off course';
    }

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
    $('fix-time').textContent = clockFmt.format(new Date(lastMs));
    document.querySelector('.readout--hero').classList.toggle('is-stale', age > STALE_MS);

    $('elapsed').textContent = now < START_MS ? '—' : hhmm(now - START_MS);
    $('elapsed-sub').textContent = `of ${CFG.targetHours} h target`;

    let miles = 0;
    for (let i = 1; i < fixes.length; i++) miles += haversineMiles(fixes[i - 1], fixes[i]);
    $('distance').textContent = `${miles.toFixed(1)} mi`;

    $('position').textContent = `${last.lat.toFixed(5)}, ${last.lon.toFixed(5)}`;

    renderPings(fixes, now);
    renderCourseReadout(snapToCourse(last.lat, last.lon), fixes, ago(age), age > STALE_MS);

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

  function renderRail() {
    const list = $('stage-rail');
    const now = Date.now();
    list.innerHTML = '';

    CFG.stages.forEach((s) => {
      const startMs = START_MS + s.startOffsetHours * 3600000;
      const endMs = startMs + s.durationHours * 3600000;

      const li = document.createElement('li');
      li.className =
        'stage' + (now >= startMs && now < endMs ? ' is-now' : '') + (now >= endMs ? ' is-done' : '');
      li.innerHTML = `
        <p class="stage__n">${s.n}</p>
        <p class="stage__name">${s.name}</p>
        <p class="stage__leg">${s.from} → ${s.to}</p>
        <p class="stage__num">${s.miles} mi · ${s.gain.toLocaleString()}${s.gainEstimated ? '~' : ''} ft</p>
        <p class="stage__time">${clockFmt.format(new Date(startMs))}</p>
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
      consecutiveFailures = 0;
      drawTrack(points.filter((p) => p.positioned));
      renderStats(points, status);
      note('');
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
    renderRail();
  }

  function init() {
    $('race-title').textContent = CFG.title;
    $('race-subtitle').textContent = CFG.subtitle;
    $('meta-distance').textContent = `${CFG.totalMiles} mi`;
    $('meta-start').textContent = clockFmt.format(new Date(START_MS));
    document.title = `${CFG.title} · Live Track`;

    initMap();
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
