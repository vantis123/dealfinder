import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cached, peek } from "@/lib/response-cache";

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
//
// Wrapped in a 20s stale-while-revalidate cache: Supabase's own internal
// metrics query (application_name=postgres_exporter) periodically saturates
// this project's DB compute, making every query — even trivial ones — take
// 8-30s+. We can't cancel that backend (permission denied, it holds
// SUPERUSER and our role doesn't). This cache means the dashboard keeps
// showing the last-known-good list (marked `stale`) instead of spinning
// forever while a background refresh races the slow DB.
export async function GET(req: Request) {
  const source = new URL(req.url).searchParams.get("source");
  const key = `deals:${source || "all"}`;

  const fetchDeals = async () => {
    let q = sb.from("deals").select("*");
    if (source && source !== "all") q = q.eq("source_type", source);
    const { data, error } = await q
      .order("flagged", { ascending: false, nullsFirst: false })
      .order("spread", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    return (data || []).map(toDeal);
  };

  const buildBody = (deals: ReturnType<typeof toDeal>[], stale: boolean, error?: string) => ({
    deals,
    stats: {
      total: deals.length,
      flagged: deals.filter((d) => d.flagged).length,
      duplicates: deals.filter((d) => d.duplicate).length,
      equity: deals.filter((d) => d.flagged).reduce((s, d) => s + (d.spread || 0), 0),
    },
    ...(stale ? { stale: true } : {}),
    ...(error ? { error } : {}),
  });

  try {
    const { data: deals, stale } = await cached(key, 20000, fetchDeals, 10000);
    return NextResponse.json(buildBody(deals, stale));
  } catch (e: any) {
    const fallback = peek<ReturnType<typeof toDeal>[]>(key);
    if (fallback) return NextResponse.json(buildBody(fallback, true, "upstream-slow"));
    return NextResponse.json(buildBody([], false, e?.message || "upstream-timeout"));
  }
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
