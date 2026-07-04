import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Freshest high-split finds across ALL sources — reads the unified `deals` spine.
// Powers the "New Deals" tab (was a 404 before this route existed).
const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co"),
  (process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key"),
  { auth: { persistSession: false } }
);
const num = (v: any) => (v != null ? Number(v) : null);

// GET /api/new-deals → array of deals (best split first). The page filters by min-split + source.
export async function GET() {
  const { data, error } = await sb
    .from("deals")
    .select("*")
    .order("spread", { ascending: false, nullsFirst: false });
  if (error) return NextResponse.json([], { status: 200 });
  const rows = (data || []).map((r: any) => ({
    caseNumber: r.source_ref,
    source: r.source_type === "auction" ? "auction" : "clerk",
    county: r.county,
    propertyAddress: r.property_address,
    owed: num(r.owed),
    value: num(r.value),
    spread: num(r.spread),
    auctionDate: r.auction_date,
    status: r.status,
    foundAt: r.created_at,
  }));
  return NextResponse.json(rows);
}
