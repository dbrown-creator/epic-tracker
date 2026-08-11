# Decisions

## Summary

**What I did.** Verified the whole chain against your real feed and a live
repo: SPOT → poller → `track.json` → Action → Pages, now serving at
<https://dbrown-creator.github.io/epic-tracker/>. Fixed a credential leak,
hardened the poller against the failures that happen while you're on a bike,
built the course overlay from the official route export, and rewrote the page
to snap your position to the course so it can say *Mich. Creek Climb, Stage 3*
instead of *39.45, -105.91*.

**Read these three first.**

1. **Your tracker battery reported `LOW`** on last night's check-in
   (04:19 UTC, 22:19 MDT). Fresh lithium AAAs before the start. No amount of
   this work survives the device dying at hour 20.
2. **The scheduled workflow has not fired once.** In the hour after it was
   pushed it produced zero scheduled runs — only the manual one I triggered.
   The workflow is `active` and the manual run works, so this is GitHub's
   scheduler being best-effort, exactly as the README warns. **Do not rely on
   the cron alone.** Run the fallback loop from a machine that stays awake
   (`scripts/fallback-poll.sh`).
3. **The commit half of the chain is still unproven.** The Action fetched and
   ran green, but your feed has had no new fix since last night, so it has
   never actually committed and pushed. Press the OK button on the Gen4 and
   it will prove itself within ten minutes.

**What I'd do next**, in order: watch a real bot commit land and tag
`v1-working`; night/dark mode for the 4am-in-bed case, which the design
currently has no answer for; the elevation profile (possible for four of six
stages only); vendoring Leaflet so a CDN outage cannot take the map out.

**What I'd flag as risky.** The cron not firing is the single biggest threat
and it is not something I can fix in this repo. Everything else degrades
gracefully; that doesn't.

---

## Decisions

**Stopped the poller writing your feed ID into the public archive.** The SPOT
response echoes the feed ID back as `feed.id`, and the poller copied it
straight into `track.json`, which the Action commits to a public repo. Your
README warns that anyone holding that ID can read a week of your position
history, so the setup was publishing the credential it tells you to protect.
The poller now keeps name/description/status only, and refuses to write at all
if the serialized output still contains the ID.

**The archive is treated as irreplaceable.** SPOT drops everything older than
seven days, so a corrupted `track.json` is unrecoverable. Writes go to a temp
file and are renamed, so a killed process cannot leave a truncated file; the
poller refuses to write if the archive would shrink; and a mid-pagination
failure keeps the pages already fetched rather than discarding the run.
`scripts/test-poll.mjs` asserts these properties against a mock feed
(`scripts/mock-spot.mjs`) that reproduces all three documented response shapes
plus malformed bodies, 429s, mid-pagination 500s and timeouts. 22/22 pass. The
bar is not "succeeds" but "never damages the archive".

**Retries on 429 and 5xx with backoff, honouring `Retry-After`.** Previously a
single rate limit failed the whole run. The retry budget is deliberately small
— the cron comes round again, so giving up quietly is fine.

**Health lives in `docs/data/status.json`, not in `track.json`.** You asked to
be consulted before changing the archive's shape, and mixing liveness state
into the permanent record is wrong anyway. The heartbeat is written on every
run including failures, so its own staleness is the signal. This is what lets
the page distinguish *he has stopped* from *the pipeline has stopped* — which
otherwise look identical, and the second is the dangerous one because it looks
calm.

**Cron dropped from 5 to 10 minutes.** The Gen4 only fixes every 10, so a
5-minute poll mostly re-reads the same message. More importantly every commit
rebuilds Pages, and GitHub soft-limits that to about 10 builds/hour; a
heartbeat every 5 minutes would sit at 12/hour and risk throttling the page
itself. At 10 minutes it costs about 6/hour.

**Course overlay is generated, not hand-made.** `scripts/build-courses.mjs`
reads `routes/breck-epic-2026.json` and emits per-stage GeoJSON, markers,
hazard polygons and a course index. The source file stays committed and
untouched. The build is deterministic — byte-identical on rebuild.

| | bytes |
| --- | --- |
| source `breck-epic-2026.json` | 4,833,169 |
| generated total | 310,590 |
| generated total, gzipped (what a phone pulls) | 86,403 |

Per-stage, at 0.00006° tolerance (~7 m):

| stage | points | kept | reduction | raw miles | bytes | gz |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Pennsylvania Creek | 12,231 | 658 | −94.6% | 34.92 | 17,768 | 5,206 |
| 2 Colorado Trail | 15,329 | 819 | −94.7% | 41.42 | 22,060 | 6,398 |
| 3 Mount Guyot | 14,806 | 662 | −95.5% | 38.91 | 14,571 | 3,866 |
| 4 Aqueduct | 15,525 | 818 | −94.7% | 41.47 | 17,938 | 4,672 |
| 5 Wheeler | 12,629 | 426 | −96.6% | 24.13 | 11,540 | 3,581 |
| 6 Gold Dust | 10,572 | 524 | −95.0% | 31.09 | 14,171 | 4,263 |
| MEGA EPIC | 79,772 | 3,958 | −95.0% | 216.00 | 86,246 | 22,065 |

**Distance is measured on the full-resolution line, then carried onto the
vertices that survive simplification.** Measuring the simplified line instead
loses 1.4% — three miles over the course — because Douglas-Peucker cuts
switchbacks, which is precisely the error the page already warns about for
straight-line fixes. It would have been quietly wrong all race.

**Longitude is scaled by cos(latitude) before simplifying.** Without it a
degree of longitude is treated as a degree of latitude and simplification is
much harsher east-west than north-south.

**Stages are located along the master line by walking it forward, not by
proximity.** Nearest-line assignment put stage 1 across 189 miles of course,
because all six stages begin and end at a handful of shared Breckenridge
trailheads — the Ice Rink alone appears at mile 0, 185 and 216. The build now
walks the master line in order with a bounded search window, giving monotonic
spans and 7.7 miles of transfers between stages. Marker mileage is resolved
the same way, inside each marker's own stage; snapping globally had put a
stage 1 water point at mile 113 and surfaced it as a crew intercept.

Resulting spans: 1: 0–35.8, 2: 36.0–77.3, 3: 77.3–113.6, 4: 114.7–154.7,
5: 157.9–182.0, 6: 185.1–216.0.

**Aid stations excluded entirely, as you asked.** All seven. Water (1), road
crossings and vehicle interfaces (9), and climbs/landmarks (16) are kept —
matching the counts in your brief exactly.

**Position is snapped to the course.** This is the biggest readability win
available and you flagged it as such. It gives real stage detection, real
along-course mileage, and the name of the climb you're on. The straight-line
figure is still shown, still labelled "straight lines between fixes" — I have
not applied any fudge factor to it.

**Timezone is derived, not hardcoded.** `config.js` now states a local
wall-clock start plus `America/Denver`, and the page resolves the offset at
that instant via `Intl`. The old `-06:00` was correct but was a fact about
this August, not about the zone.

**A compact status strip above the map on phones.** At 390px the map alone
pushed "last fix" below the fold, which is backwards for a page whose one job
is answering where you are and whether you're moving. It shows last fix, where,
and course mileage in one line, and turns red when stale.

**The active stage is lifted, the other five recede.** Six overlapping lines
at equal weight was a plate of spaghetti — see `shots/` before and after.

**Layers are reused rather than rebuilt.** The old code tore down and recreated
every marker on each 60-second refresh; over a 20-hour open tab that is how you
end up using a gigabyte. Per-fix dots are only rebuilt when the fix count
changes, and the page skips refreshing entirely while the tab is hidden.

**Failures are visible.** Tile errors past a threshold say so; two consecutive
failed fetches of `track.json` say so; a stale or failed poller heartbeat says
so and states that nothing below it is confirmed current.

**Rendering harness.** `scripts/make-fixtures.mjs` walks synthetic fixes along
the real course line, so stage detection and climb naming are genuinely
exercised. `scripts/shoot.mjs` serves a copy of `docs/` from `tmp/preview` with
the fixture swapped in — the real `docs/data/track.json` is never touched — and
freezes the browser clock so shots are reproducible. Seven states at desktop
and 390px. Fixtures are gitignored so they can never be mistaken for history.

---

## Assumptions

**The Gen4 is on 10-minute tracking, not 5.** *Matters a lot if wrong.* The
ping meter's twelve ticks are one per expected 10-minute window over two hours.
If you're actually on 5-minute tracking the meter reads as 50% packet loss all
race, and `staleAfterMinutes: 25` is too lenient by half.

**The last fix arriving is the only liveness signal that matters to viewers.**
*Matters moderately.* I've assumed nobody wants a "moving / stopped" verdict
beyond fix age and the ping meter. Stop and sleep detection from clustered
fixes is in your P2 list and I have not built it.

**Simplification at 7 m is invisible at usable zooms.** *Matters little.* At
maximum topo zoom (16) a 7 m deviation is roughly 2 px. I checked the rendered
overlay against the raw line by eye in the screenshots, not systematically.

**Stage 3's span is about 2.6 miles shorter than its own line measures.**
*Matters little.* Its endpoint matched slightly early on the master line. Every
other stage is within 1.5 miles. It shifts the stage 3/4 boundary a little; it
does not affect total progress, which comes from the master line.

**Snapping tolerance of 0.5 miles for "on course".** *Matters moderately.*
Beyond that the page says "Off course" rather than guessing a mileage. If the
Aqueduct tree cover throws fixes further than that you'll see spurious
off-course readings. I have not tested against real GPS scatter, only
synthetic ±0.00025°.

**Pace for the crew ETA uses the last two hours of fixes.** *Matters little,
and only to the crew readout.* On a long descent it will read optimistically.

**Elevation exists for stages 1, 2, 5, 6 only.** *Confirmed, not assumed* —
stages 3, 4 and the master line are `[lon,lat]` only. I have not built the
elevation profile, and I have not wired up any DEM lookup, since you flagged
that as a tell-me-first decision.

**Nobody needs the page to work offline.** *Matters moderately.* There is no
service worker, so there's also no stale-service-worker risk. A phone with no
signal at a trailhead gets nothing.

---

## Open questions for Dave

1. **Is the Gen4 on 10-minute or 5-minute tracking?** Everything about the ping
   meter and staleness thresholds keys off this.
2. **The scheduled workflow has not fired once in an hour — do you want me to
   set up a second independent trigger,** or will you run the fallback loop on
   a machine at home?
3. **Do you want night/dark mode?** People will look at this at 4am in bed and
   the current sheet is a bright buff paper. I'd do it as a
   `prefers-color-scheme` variant of the quadrangle palette, not a different
   design.
4. **Elevation profile for four of six stages, or none at all?** A profile that
   silently omits Guyot and Aqueduct may be worse than no profile.
5. **Should the page show a "moving / stopped" verdict** derived from clustered
   fixes, or is fix age plus the ping meter enough?
6. **`config.js` gain figures for stages 3 and 4 are your estimates** and are
   marked with a `~` on the page. Do you want them shown at all, or dropped
   until they can be measured?
7. **Is 0.5 miles the right "off course" threshold**, or would you rather it
   never says off-course and just always reports the nearest mileage?
8. **Do you want Leaflet and the fonts vendored into the repo?** Right now a
   unpkg or Google Fonts outage degrades the page. Vendoring is zero new
   dependencies and removes two third-party runtime calls.
