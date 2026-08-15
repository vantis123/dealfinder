#!/bin/bash
cd /Users/Krownz/dealfinder-standalone || exit 1
LOGDIR=/private/tmp/claude-502/-Users-Krownz-vantis-hq/2760ed8a-4857-41b6-91b0-4279c197f49e/scratchpad
prev=-1
for i in $(seq 1 8); do
  echo "===== PASS $i  $(date +%H:%M:%S) ====="
  node scripts/skiptrace-run.mjs --source=preforeclosure 2>&1 | tee "$LOGDIR/st_pass_$i.log"
  N=$(grep -oE 'skip-tracing [0-9]+ lead' "$LOGDIR/st_pass_$i.log" | head -1 | grep -oE '[0-9]+'); N=${N:-0}
  echo ">>> pass $i started with $N lead(s) to process"
  if [ "$N" -eq 0 ]; then echo ">>> CONVERGED — 0 remaining to trace"; break; fi
  if [ "$N" -eq "$prev" ]; then echo ">>> STALLED at $N (remaining are un-findable no-matches) — stopping"; break; fi
  prev=$N
  echo ">>> cooldown 45s before resume/next pass"; sleep 45
done
echo "===== SYNC TO DEALS SPINE  $(date +%H:%M:%S) ====="
node scripts/normalize-deals.mjs
echo "===== WATCHDOG COMPLETE  $(date +%H:%M:%S) ====="
