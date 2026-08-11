/* Everything you'd want to adjust lives here. */

window.RACE_CONFIG = {
  title: 'Mega Epic',
  subtitle: 'Individual time trial · Breckenridge, Colorado',
  rider: 'Dave Brown',

  // Local wall-clock start, plus the zone it is stated in. The offset is
  // derived from the zone at that instant rather than written down, so this
  // stays correct regardless of what the offset happens to be.
  startLocal: '2026-08-12T09:00:00',
  timeZone: 'America/Denver',

  targetHours: 58,

  // Measured from the official route export, not estimated. The MEGA EPIC
  // line is 216.0 mi; the six stage lines total 211.9, the balance being
  // transfers between stage finishes and the next stage start.
  totalMiles: 216.0,

  // Gen4 ping cadence, and how long silence goes before the page says so.
  pingIntervalMinutes: 10,
  staleAfterMinutes: 25,

  // The poller writes a heartbeat every run. If it is older than this, the
  // pipeline itself is suspect and the page says so rather than showing a
  // confidently frozen dot.
  pollerStaleAfterMinutes: 30,

  // How often the page re-reads track.json.
  refreshSeconds: 60,

  // miles/gain: measured from routes/breck-epic-2026.json where the export
  // carries elevation (stages 1, 2, 5, 6). Stages 3 and 4 are [lon,lat] only,
  // so their gain figures remain Dave's estimates and are marked as such.
  stages: [
    {
      n: 1,
      name: 'Pennsylvania Creek',
      from: 'Ice Rink',
      to: 'Carter Park',
      miles: 34.9,
      gain: 5700,
      startOffsetHours: 0,
      durationHours: 5.5,
    },
    {
      n: 2,
      name: 'Colorado Trail',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 41.4,
      gain: 6900,
      startOffsetHours: 6.5,
      durationHours: 7.25,
    },
    {
      n: 3,
      name: 'Mount Guyot',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 38.9,
      gain: 6182,
      gainEstimated: true,
      startOffsetHours: 18,
      durationHours: 7.5,
      note: 'French Pass at sunrise',
    },
    {
      n: 4,
      name: 'Aqueduct',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 41.5,
      gain: 7100,
      gainEstimated: true,
      startOffsetHours: 26.75,
      durationHours: 7.5,
    },
    {
      n: 5,
      name: 'Wheeler',
      from: 'Beaver Run',
      to: 'Peaks Trailhead',
      miles: 24.1,
      gain: 5227,
      startOffsetHours: 40,
      durationHours: 7.75,
    },
    {
      n: 6,
      name: 'Gold Dust',
      from: 'Ice Rink',
      to: 'Ice Rink',
      miles: 31.1,
      gain: 3740,
      startOffsetHours: 49,
      durationHours: 6.25,
    },
  ],

  // Shown in the gaps between stages on the schedule rail.
  rests: [
    { label: 'Sleep', afterStage: 2 },
    { label: 'Sleep', afterStage: 4 },
  ],
};
