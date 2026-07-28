import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// Scan settings = the control-plane for the daily scanner. Stored as a JSON file on the box
// (data/scan_settings.json) so daily.mjs + the schedule reconciler read the same source of truth.
// No DB migration needed — it's a single small config.

export const dynamic = "force-dynamic";

const FILE = join(process.cwd(), "data", "scan_settings.json");

const DEFAULTS = {
  enabled_counties: ["Orange", "Seminole", "Lake", "Polk", "Volusia", "Brevard", "Osceola"],
  scan_time: "07:00",            // HH:MM, local to timezone
  scan_days: "daily",            // "daily" | "weekdays" | "mon,tue,wed,thu,fri,sat,sun"
  timezone: "America/New_York",
  updated_at: null as string | null,
};

function read() {
  try {
    if (existsSync(FILE)) return { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {}
  return { ...DEFAULTS };
}

export async function GET() {
  return NextResponse.json(read());
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const cur = read();
    const next = {
      ...cur,
      ...(Array.isArray(body.enabled_counties) ? { enabled_counties: body.enabled_counties } : {}),
      ...(typeof body.scan_time === "string" ? { scan_time: body.scan_time } : {}),
      ...(typeof body.scan_days === "string" ? { scan_days: body.scan_days } : {}),
      ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
      updated_at: new Date().toISOString(),
    };
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(next, null, 2));
    return NextResponse.json({ ok: true, settings: next, message: "Saved. The daily scanner will use these on its next run." });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to save" }, { status: 400 });
  }
}
