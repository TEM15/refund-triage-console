#!/usr/bin/env bash
set -euo pipefail

URL="${1:?usage: ./scripts/replay.sh https://your-app.vercel.app}"

# This is the loop from the assessment document, unchanged.
while read -r line; do
  curl -sS -X POST "$URL/api/webhooks/orders" \
    -H 'content-type: application/json' -d "$line" > /dev/null
done < events.ndjson

echo "ingest finished"

# Now drain the workflow queue until nothing is left.
while true; do
  RESULT=$(curl -sS -X POST "$URL/api/workflow/tick?limit=25")
  echo "$RESULT"
  echo "$RESULT" | grep -q '"remaining":0' && break
  sleep 2
done

echo "workflow drained"