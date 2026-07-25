import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Switch the ACTIVE Apify subscription — swaps APIFY_API_TOKEN (what every scan/valuation
// script reads via loadEnv on each run) with APIFY_API_TOKEN_DYER in .env. Takes effect on
// the next scan run; no restart needed for the crons (they re-read .env every launch).
export async function POST() {
  const envPath = join(process.cwd(), ".env");
  let text: string;
  try { text = readFileSync(envPath, "utf8"); } catch {
    return NextResponse.json({ error: "no .env found" }, { status: 500 });
  }

  const get = (key: string) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const primary = get("APIFY_API_TOKEN");
  const alt = get("APIFY_API_TOKEN_DYER");
  if (!primary || !alt || !alt.startsWith("apify_api_")) {
    return NextResponse.json(
      { error: "Second account not configured — paste Dyer's token into APIFY_API_TOKEN_DYER in .env first" },
      { status: 400 }
    );
  }

  text = text
    .replace(new RegExp(`^APIFY_API_TOKEN=.*$`, "m"), `APIFY_API_TOKEN=${alt}`)
    .replace(new RegExp(`^APIFY_API_TOKEN_DYER=.*$`, "m"), `APIFY_API_TOKEN_DYER=${primary}`);
  writeFileSync(envPath, text);

  // Update this server process too so the Usage tab reflects the swap immediately.
  process.env.APIFY_API_TOKEN = alt;
  process.env.APIFY_API_TOKEN_DYER = primary;

  return NextResponse.json({ ok: true, note: "Active Apify account switched — next scan uses it" });
}
