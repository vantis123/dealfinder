import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import { join } from "path";

// scanner + status live at the repo root (this file is app/api/foreclosures/scan/route.ts → 4 levels up)
const ROOT = join(process.cwd());
const STATUS = join(ROOT, "scan-status.json");
const SCRIPTS: Record<string, string> = {
  Orange: join(ROOT, "scripts", "run-month.mjs"),
  Seminole: join(ROOT, "scripts", "run-seminole.mjs"),
};

// Heartbeat window: run-month.mjs rewrites scan-status.json after every case
// (pushStatus()), so a live scan keeps the file "fresh". If the worker hard-crashes
// (OOM/kill), it never writes running:false — without a heartbeat check the scan
// button stays dead for up to 12h. If the file hasn't been touched in this long,
// treat the lock as stale and allow a new scan.
const STALE_LOCK_MS = 30 * 60 * 1000; // 30 min

function readStatus(): any {
  try { return JSON.parse(readFileSync(STATUS, "utf8")); } catch { return { running: false }; }
}

// Age (ms) of the status file since last write, or Infinity if unavailable.
function statusFileAgeMs(): number {
  try { return Date.now() - statSync(STATUS).mtimeMs; } catch { return Infinity; }
}

export async function GET() {
  return NextResponse.json(readStatus());
}

// POST { county, from, to } (ISO YYYY-MM-DD) — or { county, month, year } — kick off a scan on this machine.
export async function POST(req: Request) {
  const { month, year, county, from, to } = await req.json().catch(() => ({}));
  const cur = readStatus();
  // Locked only if flagged running AND started within 12h AND the heartbeat is fresh.
  // A stale heartbeat means the worker died without clearing the flag — allow a new scan.
  const withinMaxRun = cur.startedAt && Date.now() - new Date(cur.startedAt).getTime() < 12 * 3600 * 1000;
  const heartbeatFresh = statusFileAgeMs() < STALE_LOCK_MS;
  if (cur.running && withinMaxRun && heartbeatFresh) {
    return NextResponse.json({ ok: false, error: "A scan is already running", status: cur }, { status: 409 });
  }
  const cty = county === "Seminole" ? "Seminole" : "Orange";
  const script = SCRIPTS[cty];

  // date range wins; otherwise fall back to month/year. Tag scan_month/year from the "to" date.
  const dr = /^\d{4}-\d{2}-\d{2}$/;
  const env: Record<string, string> = { ...process.env as Record<string, string>, COUNTY: cty, CONCURRENCY: process.env.FORECLOSURE_CONCURRENCY || "1" };
  if (from && to && dr.test(from) && dr.test(to)) {
    if (from > to) return NextResponse.json({ ok: false, error: "'from' date is after 'to' date" }, { status: 400 });
    env.DATE_FROM = from; env.DATE_TO = to;
    env.SCAN_MONTH = String(parseInt(to.slice(5, 7), 10)); env.SCAN_YEAR = to.slice(0, 4);
  } else {
    const m = parseInt(String(month), 10), y = parseInt(String(year), 10);
    if (!m || !y) return NextResponse.json({ ok: false, error: "date range (from/to) or month+year required" }, { status: 400 });
    env.SCAN_MONTH = String(m); env.SCAN_YEAR = String(y);
  }

  const child = spawn("node", [script], { cwd: ROOT, env, detached: true, stdio: "ignore" });
  child.unref();
  return NextResponse.json({ ok: true, started: true, county: cty, from: env.DATE_FROM, to: env.DATE_TO });
}
