import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

// scanner + status live at the repo root (this file is app/api/foreclosures/scan/route.ts → 4 levels up)
const ROOT = join(process.cwd());
const STATUS = join(ROOT, "scan-status.json");
const SCRIPT = join(ROOT, "scripts", "run-month.mjs");

function readStatus(): any {
  try { return JSON.parse(readFileSync(STATUS, "utf8")); } catch { return { running: false }; }
}

export async function GET() {
  return NextResponse.json(readStatus());
}

// POST { month, year } — kick off a month scan (scrape → Apify valuation) on this machine.
export async function POST(req: Request) {
  const { month, year } = await req.json().catch(() => ({}));
  const cur = readStatus();
  if (cur.running && cur.startedAt && Date.now() - new Date(cur.startedAt).getTime() < 12 * 3600 * 1000) {
    return NextResponse.json({ ok: false, error: "A scan is already running", status: cur }, { status: 409 });
  }
  const m = parseInt(String(month), 10), y = parseInt(String(year), 10);
  if (!m || !y) return NextResponse.json({ ok: false, error: "month and year required" }, { status: 400 });

  const child = spawn("node", [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, SCAN_MONTH: String(m), SCAN_YEAR: String(y), CONCURRENCY: process.env.FORECLOSURE_CONCURRENCY || "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return NextResponse.json({ ok: true, started: true, month: m, year: y });
}
