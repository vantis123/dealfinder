import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// The unified `deals` spine — every source (preforeclosure, auction, future code_violation…)
// normalizes into this one table. CRM boards read/filter this; changing a deal's stage moves it.
const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co"),
  (process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key"),
  { auth: { persistSession: false } }
);

const num = (v: any) => (v != null ? Number(v) : null);

function toDeal(r: any) {
  return {
    id: r.id,
    source: r.source_type,                 // preforeclosure | auction
    caseNumber: r.source_ref,
    county: r.county,
    propertyAddress: r.property_address,
    lat: num(r.lat), lng: num(r.lng),
    value: num(r.value),
    owed: num(r.owed),
    spread: num(r.spread),
    stage: r.stage,
    status: r.status,
    flagged: r.flagged,
    auctionDate: r.auction_date,
    phones: r.phones || null,
    skiptraceName: r.skiptrace_name || null,
    ghlContactId: r.ghl_contact_id || null,
    duplicate: !!r.duplicate,
    dupGroup: r.dup_group || null,
    note: r.knock_note || null,
    sourceUrl: r.source_url || null,
    foundAt: r.created_at || null,        // when the scan first added it to the pipeline
  };
}

// GET /api/deals?source=preforeclosure|auction|all  → all deals (worth-it first, then spread)
export async function GET(req: Request) {
  const source = new URL(req.url).searchParams.get("source");
  let q = sb.from("deals").select("*");
  if (source && source !== "all") q = q.eq("source_type", source);
  const { data, error } = await q
    .order("flagged", { ascending: false, nullsFirst: false })
    .order("spread", { ascending: false, nullsFirst: false });
  if (error) return NextResponse.json({ deals: [], error: error.message });
  const deals = (data || []).map(toDeal);
  return NextResponse.json({
    deals,
    stats: {
      total: deals.length,
      flagged: deals.filter((d) => d.flagged).length,
      duplicates: deals.filter((d) => d.duplicate).length,
      equity: deals.filter((d) => d.flagged).reduce((s, d) => s + (d.spread || 0), 0),
    },
  });
}

// POST /api/deals  { id, stage?, status?, note? }  → move a deal to a stage / update status/note
export async function POST(req: Request) {
  const { id, stage, status, note } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const patch: any = { updated_at: new Date().toISOString() };
  if (stage !== undefined) patch.stage = stage;
  if (status !== undefined) patch.status = status;
  if (note !== undefined) patch.knock_note = note;
  const { error } = await sb.from("deals").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
