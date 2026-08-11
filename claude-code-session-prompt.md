# Claude Code session prompt

Paste everything below the line into Claude Code after unzipping the project
and `cd`-ing into it.

---

You're picking up a working scaffold for a live GPS tracking page. I want you
to take it as far as you can on your own tonight. Work autonomously, make
judgment calls, and log them for me to review — don't stop to ask unless
you hit something on the "ask me" list below.

## What this is

I'm riding all six Breck Epic stage courses end to end as one continuous solo
effort — 217 miles, six stages, self-supported, no aid stations. Starting
Wednesday 12 August at 09:00 MDT, targeting about 58 hours.

I'll be wearing a SPOT Gen4 satellite messenger. This project turns its feed
into a page my partner (who is crewing), friends, and the local riding
community can watch. The page has one job: **answer "where is he right now and
is he moving."** Everything else is secondary to that.

The architecture is already chosen and works: a GitHub Actions cron polls the
SPOT public feed, commits new fixes to `docs/data/track.json`, and GitHub Pages
serves a static page that reads it. No server, no proxy. The committed JSON is
also the permanent archive — SPOT's API only serves the last 7 days and then
the data is gone forever.

Read `README.md` first. It documents the setup and three real quirks of the
SPOT API that the poller already handles.

## Before you improve anything

The critical path is: feed returns data → Action commits it → Pages renders it.
Prove that end to end before touching a single line of design.

1. I'll give you the feed ID as an env var. Never write it into a file.
2. Run `SPOT_FEED_ID=... node scripts/poll.mjs` against the real feed. Look at
   what actually comes back — the poller was written against SPOT's published
   schema and tested against a mock, never against my device.
3. If the real response differs from what the poller expects, fix the poller
   and say so loudly in your notes.
4. Once the whole chain works, commit and tag it `v1-working`. That tag is my
   fallback. From there on, **`main` must always be in a deployable state.**
   Do experimental work on branches and merge only what you've verified.

If you can't verify the chain — no feed access, no push rights, whatever —
stop and tell me. Don't build on an unverified foundation for six hours.

## Priorities, in order

**P0 — Correctness.** Timezone handling (everything is America/Denver, the race
crosses two midnights, and DST is not a factor but don't hardcode an offset).
Empty state before the first fix. The archive must never lose points or change
shape in a way that orphans existing data. Poller must survive a malformed or
partial response without corrupting `track.json`.

**P1 — Resilience.** This runs unattended for 58 hours while I'm on a bike and
unable to fix anything. Think about what breaks at 3am: a rate limit, a tile
server hiccup, a stale service worker, a workflow that silently stops
committing, a browser tab left open for 20 hours leaking memory. Handle
failures visibly rather than silently — a page that says "no data for 40
minutes" is useful; a page that quietly shows a frozen dot is dangerous.

**P2 — Features that serve the one job.** The official route data (see below)
unlocks most of these: snap my position to the course line to get real stage
detection and along-course progress; show plan-versus-actual as a delta; name
the climb I'm currently on; detect stops and sleeps from clustered fixes; an
elevation profile with current position marked; a compact crew view for a phone
at a trailhead; a shareable preview card.

**P3 — Polish.** Design refinement, motion, typography, mobile.

Spend your time roughly in that order. A beautiful page that shows stale data
is worse than a plain page that's honest about it.

## Design direction — keep it

The current look is deliberate and I like it. Don't restyle it wholesale.

It's built as a **USGS 7.5-minute topographic quadrangle sheet**: buff paper,
brown contour lines, woodland green, water blue, red overprint for the live
track. The map sits inside a printed neatline; the readouts live in the margin
collar the way a real quad carries its metadata. Type is Bitter for display and
IBM Plex Mono for anything numeric.

The signature element is the ping meter — twelve ticks for the last two hours,
one per expected 10-minute fix window, filled or hollow. Silence on a satellite
tracker is real information, and the meter makes it legible. Keep that idea
even if you improve the execution.

Deliberately avoided: the dark-background-with-acid-accent tracker look. SPOT's
own page already looks like that. Don't drift back toward it.

You may absolutely improve within this direction — spacing, hierarchy, the
mobile layout, night legibility (people will look at this at 4am in bed),
motion. Just don't replace the concept.

## The official route data — use this for the overlay

`routes/breck-epic-2026.json` is the official Breck Epic 2026 route export
(CalTopo GeoJSON, 4.7 MB, 58 features). This is the source of truth for the
course overlay. The current `docs/app.js` parses GPX files that don't exist —
**rip that out and load from this instead.**

I've already inspected it. What's in there:

**Seven LineStrings.** Six stages plus a single continuous `MEGA EPIC` line of
79,772 points measuring 216.0 miles — that combined line is literally the route
I'm riding, so treat it as the master and the six stage lines as its segments.
Folder titles map cleanly to my stages:

| Folder | Points | Measured |
| --- | --- | --- |
| STAGE 1 - PENNSYLVANIA CREEK | 12,231 | 34.9 mi |
| STAGE 2 - CO TRAIL | 15,329 | 41.4 mi |
| STAGE 3 - GUYOT | 14,806 | 38.9 mi |
| STAGE 4 - AQUEDUCT | 15,525 | 41.5 mi |
| STAGE 5 - WHEELER | 12,629 | 24.1 mi |
| STAGE 6 - GOLD DUST | 10,572 | 31.1 mi |
| MEGA EPIC | 79,772 | 216.0 mi |

Reconcile these against the numbers in `config.js`, which were my estimates.
Prefer the measured values and note in DECISIONS.md where they disagreed.

**Coordinates are inconsistent and this will bite you.** Stages 1, 2, 5 and 6
are `[lon, lat, elevation_m, timestamp_ms]`. Stages 3, 4 and the MEGA EPIC line
are `[lon, lat]` only — no elevation. Anything you build that assumes uniform
dimensions will throw. This also means an elevation profile is only directly
possible for four of six stages; getting the other two would need a DEM lookup,
which is a "tell me first" decision, not something to just wire up.

**Thirty-three markers, but only on stages 1–3.** Stages 4, 5 and 6 have none.
Don't build UI that assumes every stage has landmarks.

The markers sort into four kinds, and they are not equally useful to me:

- **Aid stations (7).** I'm riding this as an individual time trial, so I have
  no access to any of them. Leave them out of the overlay entirely. Showing an
  aid station I can't use is worse than showing nothing.
- **Water (1)** and **road crossings / vehicle interfaces (9).** Keep both.
  Water matters because I'm filtering from streams. Road crossings matter
  because they're the only places a crew vehicle can reach the course — if you
  want to do something genuinely useful, surface those as candidate crew
  intercept points with an ETA based on my current position.
- **Climbs and landmarks (16).** Keep these — they're the best content on the
  page. "French Pass - Climb Start", "Heinous Hill", "Blair Witch", "Great
  Flume - start", "Anger. Disillusionment." Being able to say *he's on the
  Georgia Pass climb* rather than *he's at 39.48, -105.94* is the single
  biggest readability win available here.

**Eleven polygons** marking hazard and caution zones. Lower priority, but
they're there.

## Build the overlay, don't ship the source

Do not serve that 4.7 MB file to browsers. People will open this on LTE at a
trailhead and on phones at 4am.

Write a build script that reads `routes/breck-epic-2026.json` and emits small
per-stage GeoJSON into `docs/courses/`, plus a markers file. Simplify the lines
— 12,000 points per stage is far more than any screen can resolve, and
Douglas-Peucker at a sensible tolerance should cut it by an order of magnitude
without a visible difference. Trim coordinate precision to five decimals.
Report before/after byte sizes in DECISIONS.md so I can see the trade.

Keep the source file committed and untouched as the record. Commit the
generated files too, so Pages doesn't need a build step — but make the script
reproducible and idempotent.

If the simplified line is good enough to snap positions to, then stage
detection and along-course progress become real rather than guessed. That's the
most valuable thing in the P2 list and this data makes it possible.


Install Playwright and actually render the page. Screenshot it at desktop and
at 390px wide, look at the screenshots, and critique your own work. Do this for
each of these states, because I will see all of them:

- Before the start, zero fixes on file
- Mid-race with a few hundred fixes
- A 90-minute gap in the middle of the track
- Last fix 40 minutes ago (the stale state)
- A `HELP` message present
- Night, on a phone, one-handed

Seed realistic fake data to do this. There's a mock SPOT server pattern
described in the README quirks section you can build from. Keep the fake data
out of `docs/data/track.json` — put fixtures somewhere clearly separate so
they can't get committed as real history.

## Log your thinking

Create `DECISIONS.md` at the repo root and keep it current as you go. Three
sections:

**Decisions** — what you chose and why, one short paragraph each. Include the
ones you're confident about, not just the uncertain ones.

**Assumptions** — anything you took as true without being able to check. Mark
each with how much it matters if you're wrong. Example: "Assumed the Gen4 is on
10-minute tracking, not 5. If wrong, the ping meter reads as 50% packet loss."

**Open questions for Dave** — things you genuinely couldn't decide alone,
phrased so I can answer each in one line.

Put a short summary at the top: what you did, what you'd do next, what you'd
flag as risky. That's the first thing I'll read.

Commit in small, readable increments with real messages. I'd rather review
thirty honest commits than one giant one.

## Ask me, don't decide

- Anything that costs money or requires an account I don't already have
- Adding a dependency heavier than a small utility — justify it first, and
  prefer zero-dependency solutions for anything on the critical path
- Anything that changes the shape of `track.json` after real data exists in it
- Publishing, sharing, or posting anything anywhere
- Anything involving my location data leaving this repo — no analytics, no
  third-party embeds, no telemetry

## Things I already know, so don't re-derive them

- The schedule rail in `config.js` was worked backward from one hard
  constraint: I want to crest French Pass at sunrise on stage 3, which puts
  that stage starting around 03:00 Thursday. Stage 4 then finishes near sunset
  Thursday. Total lands at about 55 hours against a 58-hour target.
- Distance from SPOT fixes undercounts significantly — 10-minute sampling cuts
  every switchback. The page labels it "straight lines between fixes" on
  purpose. Don't silently "fix" it with a fudge factor; if you can do better
  by snapping to the course GPX, that's interesting, but say so explicitly.
- Course lines come from the official route data, not from my Strava rides —
  see the section above. Don't go looking for GPX exports.

## When to stop

Stop when you'd be guessing rather than building — when the next meaningful
improvement depends on an answer only I can give. Don't pad the session. A
clear "here's where I stopped and why" beats another hour of low-value churn.

Go.
