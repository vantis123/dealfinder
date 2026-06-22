#!/usr/bin/env bash
# Refresh Leads — scrape the chosen month, value via Apify, update Supabase + sheet + CSV.
# Usage:
#   ./scan.sh            # current month
#   ./scan.sh 6 2026     # June 2026  (month year)
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then echo "❌ No .env — run 'bash setup.sh' first."; exit 1; fi

MONTH="${1:-$(date +%-m)}"
YEAR="${2:-$(date +%Y)}"
echo "=== Refreshing door-knock leads for $MONTH/$YEAR ==="
SCAN_MONTH="$MONTH" SCAN_YEAR="$YEAR" CONCURRENCY="${CONCURRENCY:-1}" node scripts/run-month.mjs
echo ""
echo "✓ Done. Open the dashboard (npm run dev → http://localhost:3000/foreclosures)"
echo "  or the report: door-knock-leads.csv"
