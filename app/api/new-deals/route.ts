import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cached, peek } from "@/lib/response-cache";

// Freshest high-split finds across ALL sources — reads the unified `deals` spine.
// Powers the "New Deals" tab (was a 404 before this route existed).
const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co"),
  (process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key"),
  { auth: { persistSession: false } }
);
const num = (v: any) => (v != null ? Number(v) : null);

// GET /api/new-deals → array of deals (best split first). The page filters by min-split + source.
//
// 20s stale-while-revalidate cache — see lib/response-cache.ts for why:
// Supabase's own internal metrics query periodically saturates this
// project's DB compute, making every query (even on tiny tables) take
// 8-30s+. This keeps the dashboard responsive off the last-known-good list.
const CACHE_KEY = "new-deals:all";
async function fetchNewDeals() {
  const { data, error } = await sb
    .from("deals")
    .select("*")
    .order("spread", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data || []).map((r: any) => ({
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
}

export async function GET() {
  try {
    const { data: rows } = await cached(CACHE_KEY, 20000, fetchNewDeals, 10000);
    return NextResponse.json(rows);
  } catch {
    return NextResponse.json(peek<Awaited<ReturnType<typeof fetchNewDeals>>>(CACHE_KEY) || []);
  }
}
