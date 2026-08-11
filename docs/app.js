/* global L */
(function () {
  'use strict';

  const CFG = window.RACE_CONFIG;
  const START_MS = new Date(CFG.startTime).getTime();
  const PING_MS = CFG.pingIntervalMinutes * 60 * 1000;
  const STALE_MS = CFG.staleAfterMinutes * 60 * 1000;
  const PING_SLOTS = 12;

  const $ = (id) => document.getElementById(id);

  let map;
  let hasFitBounds = false;
  const layers = {};

  /* ---------- helpers ---------- */

  function haversineMiles(a, b) {
    const R = 3958.7613;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function hhmm(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const total = Math.floor(ms / 60000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  function ago(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    return `${h} h ${mins % 60} min`;
  }

  const clockFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  });

  /* ---------- map ---------- */

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

    layers.courses = L.layerGroup().addTo(map);
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

  /* ---------- course underlay ---------- */

  function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    let pts = [...doc.querySelectorAll('trkpt')];
    if (!pts.length) pts = [...doc.querySelectorAll('rtept')];
    return pts
      .map((p) => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  }

  async function loadCourses() {
    const bounds = [];
    for (const stage of CFG.stages) {
      if (!stage.gpx) continue;
      try {
        const res = await fetch(`courses/${stage.gpx}`, { cache: 'no-cache' });
        if (!res.ok) continue;
        const line = parseGpx(await res.text());
        if (line.length < 2) continue;

        L.polyline(line, {
          color: '#6E4A26',
          weight: 2.5,
          opacity: 0.45,
          lineJoin: 'round',
        })
          .bindTooltip(`Stage ${stage.n} — ${stage.name}`, { sticky: true })
          .addTo(layers.courses);

        bounds.push(...line);
      } catch (_) {
        /* a missing course file just means no underlay for that stage */
      }
    }
    if (bounds.length && !hasFitBounds) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.06));
      hasFitBounds = true;
    }
  }

  /* ---------- live track ---------- */

  function drawTrack(points) {
    layers.track.clearLayers();
    const fixes = points.filter((p) => p.positioned);
    if (!fixes.length) return;

    const line = fixes.map((p) => [p.lat, p.lon]);

    L.polyline(line, { color: '#BF3B2B', weight: 3, opacity: 0.95 }).addTo(layers.track);

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

    const last = fixes[fixes.length - 1];
    L.marker([last.lat, last.lon], {
      icon: L.divIcon({ className: '', html: '<div class="head-marker"></div>', iconSize: [16, 16] }),
      zIndexOffset: 1000,
    })
      .bindTooltip(`${CFG.rider} · ${clockFmt.format(new Date(last.t * 1000))}`, {
        permanent: false,
      })
      .addTo(layers.track);

    if (!hasFitBounds) {
      map.fitBounds(L.latLngBounds(line).pad(0.15));
      hasFitBounds = true;
    }
  }

  /* ---------- readouts ---------- */

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

  function renderStats(points) {
    const now = Date.now();
    const fixes = points.filter((p) => p.positioned);

    $('fix-count').textContent = `${fixes.length} ${fixes.length === 1 ? 'fix' : 'fixes'} on file`;

    if (!fixes.length) {
      $('map-empty').hidden = false;
      $('fix-age').textContent = '—';
      $('fix-time').textContent =
        now < START_MS ? `Starts ${clockFmt.format(new Date(START_MS))}` : 'No data yet';
      renderPings([], now);
      return;
    }

    $('map-empty').hidden = true;

    const last = fixes[fixes.length - 1];
    const lastMs = last.t * 1000;
    const age = now - lastMs;

    $('fix-age').textContent = ago(age);
    $('fix-time').textContent = clockFmt.format(new Date(lastMs));
    document.querySelector('.readout--hero').classList.toggle('is-stale', age > STALE_MS);

    const elapsed = now - START_MS;
    $('elapsed').textContent = now < START_MS ? '—' : hhmm(elapsed);
    $('elapsed-sub').textContent = `of ${CFG.targetHours} h target`;

    let miles = 0;
    for (let i = 1; i < fixes.length; i++) miles += haversineMiles(fixes[i - 1], fixes[i]);
    $('distance').textContent = `${miles.toFixed(1)} mi`;

    $('position').textContent = `${last.lat.toFixed(5)}, ${last.lon.toFixed(5)}`;

    renderPings(fixes, now);

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
        <p class="stage__num">${s.miles} mi · ${s.gain.toLocaleString()} ft</p>
        <p class="stage__time">${clockFmt.format(new Date(startMs))}</p>
        ${s.note ? `<p class="stage__note">${s.note}</p>` : ''}
      `;
      list.appendChild(li);
    });
  }

  /* ---------- boot ---------- */

  async function refresh() {
    try {
      const res = await fetch(`data/track.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`track.json returned ${res.status}`);
      const data = await res.json();
      const points = Array.isArray(data.points) ? data.points : [];
      drawTrack(points);
      renderStats(points);
    } catch (err) {
      console.warn('Could not read track data:', err.message);
      $('map-empty').hidden = false;
      $('map-empty').textContent = 'Track data unavailable. Retrying.';
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
    loadCourses();
    refresh();
    setInterval(refresh, CFG.refreshSeconds * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
