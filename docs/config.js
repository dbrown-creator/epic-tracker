/* Everything you'd want to adjust lives here. */

window.RACE_CONFIG = {
  title: 'Mega Epic',
  subtitle: 'An individual time trial of the Mega Epic course · Breckenridge, Colorado',
  rider: 'Dave Brown',

  // Local wall-clock start, plus the zone it is stated in. The offset is
  // derived from the zone at that instant rather than written down, so this
  // stays correct regardless of what the offset happens to be.
  startLocal: '2026-08-12T09:00:00',
  timeZone: 'America/Denver',

  targetHours: 58,
  // The schedule document projects a 56:48 finish against the 58h target.
  projectedHours: 56.8,

  // Measured from the official route export, not estimated. The MEGA EPIC
  // line is 216.0 mi; the six stage lines total 211.9, the balance being
  // transfers between stage finishes and the next stage start. The schedule
  // document says 217 mi / 34,805 ft — see DECISIONS.md on the disagreement.
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

  // The SPOT shared page. A second, independent view of the same device, for
  // when this page and reality disagree and someone needs a tiebreaker.
  // Set to the share URL; null hides the link.
  spotShareUrl: 'https://maps.findmespot.com/s/JVPX',

  // Stage transitions are detected from behaviour, not the clock. Every stage
  // change involves a long stop in town to reload gear and eat, sometimes to
  // sleep — at the house for most of them, the Ice Rink lot between 5 and 6.
  // Deliberately a radius around downtown rather than a fixed point at the
  // house: the house is not a rule, the stopping is.
  hub: {
    lat: 39.4817,
    lon: -106.0384,
    radiusMiles: 3,
  },
  // A stop counts as a transition at this length. Shorter halts on course —
  // filtering water, fixing a flat — are not transitions.
  transitionStopMinutes: 30,
  // How tightly fixes must cluster to count as stopped at all.
  stopRadiusMiles: 0.35,
  // ...and how much of the current stage must be behind him first, so the
  // planned hour-and-a-quarter at the house 0.8 mi into stage 2 is not read
  // as the start of stage 3.
  minStageFractionBeforeTransition: 0.6,

  // Six traces that stay apart where the stages overlap. Drawn from the
  // quadrangle palette — woodland green, water blue, and the earths — rather
  // than saturated defaults. The red overprint is deliberately not in this
  // list: it belongs to the live track and nothing else.
  //
  // startOffsetHours / durationHours come from the schedule document
  // (docs/schedule.html) and are the gun-to-finish window for each stage,
  // stops included. miles are measured from the route export; planMiles are
  // the schedule document's own figures, kept for reference where they differ.
  stages: [
    {
      n: 1,
      color: '#1F5E1A',
      name: 'Pennsylvania Creek',
      from: 'Ice Rink',
      to: 'Carter Park',
      miles: 34.9,
      planMiles: 35.7,
      gain: 5700,
      startOffsetHours: 0,
      durationHours: 5.45,
    },
    {
      n: 2,
      color: '#0B4F7A',
      name: 'Colorado Trail',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 41.4,
      gain: 6900,
      startOffsetHours: 5.75,
      durationHours: 9.1,
      note: 'Home stop 0.8 mi in · lights on ~8:35 PM',
    },
    {
      n: 3,
      color: '#5A2270',
      name: 'Mount Guyot',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 38.9,
      planMiles: 40.5,
      gain: 7100,
      gainEstimated: true,
      startOffsetHours: 18.0833,
      durationHours: 8.5333,
      note: 'French Pass at sunrise · the hardest day',
    },
    {
      n: 4,
      color: '#0A6B57',
      name: 'Aqueduct',
      from: 'Lower Washington',
      to: 'B&B Trailhead',
      miles: 41.5,
      planMiles: 42.3,
      gain: 6473,
      gainEstimated: true,
      startOffsetHours: 28.1333,
      durationHours: 7.6167,
    },
    {
      n: 5,
      color: '#B25A06',
      name: 'Wheeler',
      from: 'Beaver Run',
      to: 'Peaks Trailhead',
      miles: 24.1,
      planMiles: 24.6,
      gain: 5227,
      startOffsetHours: 41.8,
      durationHours: 7.75,
      note: 'Shortest, steepest',
    },
    {
      n: 6,
      color: '#7A3410',
      name: 'Gold Dust',
      from: 'Ice Rink',
      to: 'Ice Rink',
      miles: 31.1,
      planMiles: 30.2,
      gain: 3740,
      startOffsetHours: 50.55,
      durationHours: 6.25,
      note: 'Flattest stage, worst legs',
    },
  ],

  // What happens in the gaps between stage windows. Named so the page can say
  // "Sleep 1 — home" rather than leaving a hole in the schedule.
  breaks: [
    { afterStage: 1, label: 'Transfer to Lower Washington', kind: 'transfer' },
    { afterStage: 2, label: 'Sleep 1 — home', kind: 'sleep', note: 'Short on purpose' },
    { afterStage: 3, label: 'Home — between 3 and 4', kind: 'stop', note: 'Biggest daylight meal' },
    { afterStage: 4, label: 'Sleep 2 — home', kind: 'sleep', note: 'Decision point' },
    { afterStage: 5, label: 'Ice Rink — crewed', kind: 'stop', note: 'The fast stop' },
  ],
};
