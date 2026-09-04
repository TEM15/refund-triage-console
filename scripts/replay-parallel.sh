#!/usr/bin/env bash
set -euo pipefail

URL="${1:?usage: ./scripts/replay-parallel.sh https://your-app.vercel.app}"
WORKERS="${2:-8}"

# Eight workers posting at once. This is the hard test: two copies of
# the same event can be in flight at the same moment, in two separate
# function invocations that share no memory.
cat events.ndjson | xargs -P "$WORKERS" -I{} \
  curl -sS -X POST "$URL/api/webhooks/orders" \
  -H 'content-type: application/json' -d '{}' > /dev/null

echo "parallel ingest finished with $WORKERS workers"

while true; do
  RESULT=$(curl -sS -X POST "$URL/api/workflow/tick?limit=25")
  echo "$RESULT"
  echo "$RESULT" | grep -q '"remaining":0' && break
  sleep 2
done

echo "workflow drained"