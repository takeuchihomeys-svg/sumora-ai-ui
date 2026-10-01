#!/bin/bash
# usage: tmp-viewing-turn.sh "text" ; injects, waits for draft (max 5 min), prints state since injection
cd "C:/Users/竹内 悠馬/sumora-ai-ui"
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
npx tsx --env-file=.env.local scripts/tmp-viewing-live.ts inject "$1" | cut -c1-200
for i in $(seq 1 30); do
  sleep 10
  OUT=$(npx tsx --env-file=.env.local scripts/tmp-viewing-live.ts state $T0 2>&1)
  if echo "$OUT" | grep -q "^ai_draft: ." ; then sleep 8; break; fi
done
npx tsx --env-file=.env.local scripts/tmp-viewing-live.ts state $T0 | cut -c1-3500
