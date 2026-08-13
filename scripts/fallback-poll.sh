#!/usr/bin/env bash
# Poll, commit and push in a loop. Used two ways:
#
#   - inside the Action, to hold a single job open across a whole block of the
#     race so the cadence does not depend on GitHub's scheduler
#   - on any machine that stays awake, as a belt-and-braces second poller
#
# Safe to run both at once. Fixes are merged by message id, so two pollers
# converge on the same archive, and each rebases before pushing.
#
#   SPOT_FEED_ID=xxxx ./scripts/fallback-poll.sh
#
# Env:
#   INTERVAL      seconds between polls, default 600, floor 300
#   MAX_SECONDS   stop after roughly this long, default 0 meaning never
#   PUSH          set to 0 to poll and commit without pushing

set -uo pipefail

INTERVAL="${INTERVAL:-600}"
MAX_SECONDS="${MAX_SECONDS:-0}"
PUSH="${PUSH:-1}"

if [ -z "${SPOT_FEED_ID:-}" ]; then
  echo "SPOT_FEED_ID is not set." >&2
  exit 1
fi

# SPOT asks for at least 2.5 minutes between calls on the same feed, and two
# pollers may be running. 300s is the floor for one of them.
if [ "$INTERVAL" -lt 300 ]; then
  echo "Refusing to poll faster than every 300s — SPOT rate-limits the feed." >&2
  exit 1
fi

if [ -z "$(git config user.email || true)" ]; then
  git config user.name "spot-bot"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
fi

started=$(date +%s)
echo "Polling every ${INTERVAL}s$([ "$MAX_SECONDS" -gt 0 ] && echo " for up to ${MAX_SECONDS}s")."

sync_up() {
  local stamp="$1"

  if ! git diff --quiet -- docs/data/; then
    git add docs/data/track.json docs/data/status.json
    git commit -q -m "Fixes through ${stamp}"
  fi

  [ "$PUSH" = "0" ] && { echo "${stamp}  committed (push disabled)"; return; }

  # Push whenever the branch is ahead, not only when this iteration produced a
  # commit. A push that failed its retries used to leave the commit stranded:
  # the next iteration saw a clean working tree, reported "no change", and
  # never tried again — so the runner kept polling and the site kept serving
  # data hours old. Being ahead of the remote is the condition that matters.
  local ahead
  ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  if [ "$ahead" = "0" ]; then
    echo "${stamp}  no change"
    return
  fi
  [ "$ahead" -gt 1 ] && echo "  ${ahead} commits to push"

  for _ in 1 2 3; do
    if git push -q 2>/dev/null; then
      echo "${stamp}  pushed"
      return
    fi

    # Never rebase. Both sides rewrite the same JSON files, so a rebase hits a
    # conflict git cannot resolve unattended, leaving the repo mid-rebase — and
    # from then on every commit and push fails silently while the job keeps
    # running and looking healthy. That cost four hours of live tracking.
    #
    # Take the remote wholesale and re-derive instead. That is safe precisely
    # because the archive is not a merge: the poller reads whatever track.json
    # is on disk and merges the feed into it by message id, so re-polling after
    # resetting reproduces our points and theirs.
    echo "  push rejected, resetting to remote and re-deriving"
    git fetch -q origin main || true
    git reset -q --hard origin/main || true
    if node scripts/poll.mjs; then
      if ! git diff --quiet -- docs/data/; then
        git add docs/data/track.json docs/data/status.json
        git commit -q -m "Fixes through ${stamp}"
      fi
    fi
  done
  echo "${stamp}  PUSH FAILED" >&2
}

while true; do
  stamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

  if node scripts/poll.mjs; then
    sync_up "$stamp"
  else
    # A failed poll still writes a heartbeat, and that is worth committing so
    # the page can say the pipeline is unhealthy rather than going quiet.
    echo "${stamp}  poll failed" >&2
    sync_up "$stamp"
  fi

  if [ "$MAX_SECONDS" -gt 0 ]; then
    elapsed=$(( $(date +%s) - started ))
    # Stop before the next poll would run past the budget, so the job exits
    # cleanly and lets the queued run take over rather than being killed.
    if [ $(( elapsed + INTERVAL )) -ge "$MAX_SECONDS" ]; then
      echo "Reached time budget after ${elapsed}s. Handing off."
      exit 0
    fi
  fi

  sleep "$INTERVAL"
done
