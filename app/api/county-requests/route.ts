import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// County requests — a scanner runner / client asks for a county we don't cover yet. We save it and
// aim to add it within 48h (Vantis maps that county's value + owed sources → equity → Zillow).
const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co"),
  (process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key"),
  { auth: { persistSession: false } }
);

// GET — list requests (admin/Vantis view), newest first.
export async function GET() {
  const { data, error } = await sb
    .from("county_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json([], { status: 200 });
  return NextResponse.json(data || []);
}

// POST { state?, county, requestedBy?, contact?, notes? } — capture a new county request.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const county = String(body.county || "").trim();
  if (!county) return NextResponse.json({ error: "county is required" }, { status: 400 });
  const row = {
    state: String(body.state || "FL").trim().toUpperCase().slice(0, 2),
    county: county.replace(/\s+county$/i, "").trim(),
    requested_by: body.requestedBy ? String(body.requestedBy).slice(0, 120) : null,
    contact: body.contact ? String(body.contact).slice(0, 160) : null,
    notes: body.notes ? String(body.notes).slice(0, 600) : null,
    updated_at: new Date().toISOString(),
  };
  // Dedupe on (state, county) — a repeat request just bumps the row, doesn't create a second.
  const { error } = await sb.from("county_requests").upsert(row, { onConflict: "state,county" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, message: `Got it — ${row.county} County, ${row.state}. We'll aim to add it within 48 hours.` });
}
