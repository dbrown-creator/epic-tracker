/* Everything you'd want to adjust lives here. */

window.RACE_CONFIG = {
  title: 'Mega Epic',
  subtitle: 'Individual time trial · Breckenridge, Colorado',
  rider: 'Dave Brown',

  // Start of the clock. Mountain Daylight Time is -06:00.
  startTime: '2026-08-12T09:00:00-06:00',

  targetHours: 58,
  totalMiles: 217,

  // Gen4 ping cadence, and how long silence goes before the page says so.
  pingIntervalMinutes: 10,
  staleAfterMinutes: 25,

  // How often the page re-reads track.json.
  refreshSeconds: 60,

  // Drop a .gpx in docs/courses/ and name it here to draw the course underlay.
  stages: [
    {
      n: 1,
      name: 'Pennsylvania Creek',
      from: 'Ice Rink',
      to: 'Carter Park',
      miles: 35.7,
      gain: 5700,
      startOffsetHours: 0,
      durationHours: 5.5,
      gpx: 'stage1-pennsylvania-creek.gpx',
    },
    {
      n: 2,
      name: 'Colorado Trail',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 41,
      gain: 6900,
      startOffsetHours: 6.5,
      durationHours: 7.25,
      gpx: 'stage2-colorado-trail.gpx',
    },
    {
      n: 3,
      name: 'Mount Guyot',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 40.3,
      gain: 6182,
      startOffsetHours: 18,
      durationHours: 7.5,
      gpx: 'stage3-guyot.gpx',
      note: 'French Pass at sunrise',
    },
    {
      n: 4,
      name: 'Aqueduct',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 41,
      gain: 7100,
      startOffsetHours: 26.75,
      durationHours: 7.5,
      gpx: 'stage4-aqueduct.gpx',
    },
    {
      n: 5,
      name: 'Wheeler',
      from: 'Beaver Run',
      to: 'Peaks Trailhead',
      miles: 24.6,
      gain: 5227,
      startOffsetHours: 40,
      durationHours: 7.75,
      gpx: 'stage5-wheeler.gpx',
    },
    {
      n: 6,
      name: 'Gold Dust',
      from: 'Ice Rink',
      to: 'Ice Rink',
      miles: 30.2,
      gain: 3740,
      startOffsetHours: 49,
      durationHours: 6.25,
      gpx: 'stage6-gold-dust.gpx',
    },
  ],

  // Shown in the gaps between stages on the schedule rail.
  rests: [
    { label: 'Sleep', afterStage: 2 },
    { label: 'Sleep', afterStage: 4 },
  ],
};
