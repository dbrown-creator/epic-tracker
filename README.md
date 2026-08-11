# Mega Epic live track

A GitHub Actions cron polls a SPOT public feed, commits each new fix to
`docs/data/track.json`, and GitHub Pages serves a map that reads it.

No server, no proxy, no cost. The committed JSON is also your permanent
archive — SPOT's API only serves the last 7 days and then the points are gone
for good.

## Setup

**1. Push this to a repo.**

```bash
git init && git add . && git commit -m "Tracker"
git remote add origin git@github.com:USER/REPO.git
git push -u origin main
```

**2. Add the feed ID as a secret.**

Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
| --- | --- |
| `SPOT_FEED_ID` | your 32-character XML feed ID |
| `SPOT_FEED_PASSWORD` | only if the feed is password protected |

Keep it a secret rather than hardcoding it — anyone holding the feed ID can
read your position history for the last week.

**3. Let Actions write to the repo.**

Settings → Actions → General → Workflow permissions → **Read and write
permissions**. Without this the poll runs fine but the commit fails.

**4. Turn on Pages.**

Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, Folder:
`/docs`.

**5. Test before you trust it.**

Actions → *Poll SPOT feed* → Run workflow. Watch the log. You want either
"Wrote docs/data/track.json" or a clean "No Messages to display" if the
tracker hasn't sent anything yet. Then load the Pages URL.

Locally, same thing:

```bash
SPOT_FEED_ID=xxxx node scripts/poll.mjs
```

**6. Add the course lines.** Export GPX from your Strava recon rides into
`docs/courses/` — see the README in that folder for filenames.

## Race-day caveat

GitHub's scheduled workflows have a 5-minute floor and are explicitly
best-effort — under load they get delayed, and occasionally skipped. That's
fine for dot-watching; it is not fine as your only safety net.

If a gap matters, poll from any machine that's awake:

```bash
while true; do SPOT_FEED_ID=xxxx node scripts/poll.mjs \
  && git add -A docs/data && git commit -m "fix" && git push; sleep 300; done
```

SPOT asks for at least 2.5 minutes between calls on the same feed, so don't go
below 300 seconds if the Action is also running.

## Configuration

Everything adjustable is in `docs/config.js`: start time, stage names and
distances, the planned schedule, ping cadence, refresh interval.

The schedule rail shows the **plan**, not progress — it highlights whichever
stage the clock says you should be on. The map shows where you actually are.
Those disagreeing is information, not a bug.

## Layout

```
.github/workflows/track.yml   cron + commit
scripts/poll.mjs              fetch, page, normalize, merge
docs/index.html               the page
docs/style.css                USGS quadrangle palette
docs/config.js                race settings
docs/app.js                   map + readouts
docs/data/track.json          the archive (committed by the bot)
docs/courses/                 your GPX files
```

## Notes on the SPOT API

Three response shapes the poller already handles, and which will bite anything
you write against this API later:

- A feed with exactly one message returns `messages.message` as a bare object,
  not an array.
- Non-position messages (`HELP-CANCEL`, some `STOP`) report latitude and
  longitude as `-99999`. They're kept but flagged `positioned: false`.
- A feed with nothing in the window returns an *error envelope* (`E-0195`)
  rather than an empty list. That's normal, not a failure.

The feed only serves data from the moment the feed was created, up to 7 days.
