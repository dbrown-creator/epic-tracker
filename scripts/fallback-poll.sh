#!/usr/bin/env bash
# Poll and push from a machine that stays awake, for when GitHub's scheduler
# does not run. Safe to run at the same time as the Action: both append to the
# same archive by message id, and both rebase before pushing.
#
#   SPOT_FEED_ID=xxxx ./scripts/fallback-poll.sh
#
# Ctrl-C to stop. SPOT asks for at least 2.5 minutes between calls on the same
# feed, so this does not go below 300 seconds while the Action is also running.

set -uo pipefail

INTERVAL="${INTERVAL:-600}"

if [ -z "${SPOT_FEED_ID:-}" ]; then
  echo "SPOT_FEED_ID is not set." >&2
  exit 1
fi

if [ "$INTERVAL" -lt 300 ]; then
  echo "Refusing to poll faster than every 300s — SPOT rate-limits the feed." >&2
  exit 1
fi

echo "Polling every ${INTERVAL}s. Ctrl-C to stop."

while true; do
  stamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

  if node scripts/poll.mjs; then
    if ! git diff --quiet -- docs/data/; then
      git add docs/data/track.json docs/data/status.json
      git commit -q -m "Fixes through ${stamp}"

      pushed=0
      for _ in 1 2 3; do
        if git push -q; then pushed=1; break; fi
        echo "  push rejected, rebasing"
        git pull -q --rebase --autostash origin main || true
      done
      [ "$pushed" = 1 ] && echo "${stamp}  pushed" || echo "${stamp}  PUSH FAILED" >&2
    else
      echo "${stamp}  no change"
    fi
  else
    # A failed poll still writes a heartbeat, which is itself worth committing
    # so the page can say the pipeline is unhealthy.
    echo "${stamp}  poll failed" >&2
    if ! git diff --quiet -- docs/data/status.json; then
      git add docs/data/status.json
      git commit -q -m "Poll failure at ${stamp}"
      git push -q || git pull -q --rebase --autostash origin main && git push -q || true
    fi
  fi

  sleep "$INTERVAL"
done
