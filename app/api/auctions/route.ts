import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cached, peek } from "@/lib/response-cache";

// Auctions read from the DEDICATED `auction_leads` table — never mixed with the clerk
// pre-foreclosure `foreclosure_leads` (which /api/foreclosures serves).
const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co"),
  (process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key"),
  { auth: { persistSession: false } }
);

const num = (v: any) => (v != null ? Number(v) : null);

// GET — auction listings, worth-it first then by spread. Returns a plain array (the /auctions page maps it).
//
// 20s stale-while-revalidate cache — see lib/response-cache.ts for why:
// Supabase's own internal metrics query periodically saturates this
// project's DB compute, making every query (even on tiny tables) take
// 8-30s+. This keeps the dashboard responsive off the last-known-good list.
const CACHE_KEY = "auctions:all";
async function fetchAuctions() {
  const { data, error } = await sb
    .from("auction_leads")
    .select("*")
    .not("property_address", "is", null)   // no real address = not actionable = don't show
    .order("flagged", { ascending: false, nullsFirst: false })
    .order("spread", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data || []).filter((r: any) => String(r.property_address || "").trim()).map((r: any) => ({
    caseNumber: r.case_number,
    county: r.county,
    auctionDate: r.auction_date,
    auctionStatus: r.auction_status,
    finalJudgment: num(r.final_judgment),
    parcelId: r.parcel_id,
    propertyAddress: r.property_address,
    assessedValue: num(r.assessed_value),
    zillowValue: num(r.zillow_value),
    spread: num(r.spread),
    flagged: r.flagged,
    judgmentUrl: r.detail_url,
    saleDate: r.sale_date,
    saleLocation: r.sale_location,
    valueSheetUrl: r.value_sheet_url,
    noticeOfSaleUrl: r.notice_of_sale_url,
    finalJudgmentUrl: r.final_judgment_url,
    unpaidPrincipal: num(r.unpaid_principal),
    interestOwed: num(r.interest_owed),
    foundAt: r.scanned_at || r.updated_at || null,
    knock: { status: r.knock_status || "new", note: r.knock_note || "" },
  }));
}

export async function GET() {
  try {
    const { data: rows } = await cached(CACHE_KEY, 20000, fetchAuctions, 10000);
    return NextResponse.json(rows);
  } catch {
    return NextResponse.json(peek<Awaited<ReturnType<typeof fetchAuctions>>>(CACHE_KEY) || []);
  }
}

// POST — update knock status / note for an auction case.
export async function POST(req: Request) {
  const { caseNumber, status, note } = await req.json();
  if (!caseNumber) return NextResponse.json({ error: "caseNumber required" }, { status: 400 });
  const patch: any = { updated_at: new Date().toISOString() };
  if (status !== undefined) patch.knock_status = status;
  if (note !== undefined) patch.knock_note = note;
  const { error } = await sb.from("auction_leads").update(patch).eq("case_number", caseNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
