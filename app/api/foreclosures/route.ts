import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cached, peek } from "@/lib/response-cache";

const sbClient = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "anon",
  { auth: { persistSession: false } }
);

function toLead(r: any) {
  return {
    caseNumber: r.case_number, county: r.county, plaintiff: r.plaintiff, defendant: r.defendant, type: r.type,
    propertyAddress: r.property_address, principalDue: r.principal_due, interestOwed: r.interest_owed,
    totalOwed: r.total_owed, owedWithBuffer: r.owed_with_buffer, zillowValue: r.zillow_value, spread: r.spread,
    flagged: r.flagged, reviewStatus: r.review_status, reviewReason: r.review_reason,
    complaintUrl: r.complaint_url, valueUrl: r.value_url, docketUrl: r.docket_url,
    complaintX: !r.complaint_url, valueX: !r.value_url, hasComplaint: !!r.complaint_url, hasValue: !!r.value_url,
    phones: r.phones || [], skiptraceName: r.skiptrace_name || null,
    filingDate: r.filing_date || null, scannedAt: r.scanned_at || null,
    knock: { status: r.knock_status || "new", note: r.knock_note || "" },
  };
}

// 20s stale-while-revalidate cache — see lib/response-cache.ts for why:
// Supabase's own internal metrics query periodically saturates this
// project's DB compute, making every query (even on tiny tables) take
// 8-30s+. This keeps the dashboard responsive off the last-known-good list.
const CACHE_KEY = "foreclosures:all";
async function fetchLeads() {
  const { data, error } = await sbClient()
    .from("foreclosure_leads")
    .select("*")
    .order("flagged", { ascending: false, nullsFirst: false })
    .order("spread", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data || []).map(toLead);
}

function buildBody(leads: ReturnType<typeof toLead>[], stale: boolean, error?: string) {
  return {
    leads,
    stats: {
      total: leads.length,
      knock: leads.filter((l) => l.flagged).length,
      review: leads.filter((l) => l.reviewStatus === "manual_review").length,
      totalEquity: leads.filter((l) => l.flagged).reduce((s, l) => s + (l.spread || 0), 0),
    },
    ...(stale ? { stale: true } : {}),
    ...(error ? { error } : {}),
  };
}

export async function GET() {
  try {
    const { data: leads, stale } = await cached(CACHE_KEY, 20000, fetchLeads, 10000);
    return NextResponse.json(buildBody(leads, stale));
  } catch (e: any) {
    const fallback = peek<ReturnType<typeof toLead>[]>(CACHE_KEY);
    if (fallback) return NextResponse.json(buildBody(fallback, true, "upstream-slow"));
    return NextResponse.json(buildBody([], false, e?.message || "upstream-timeout"));
  }
}

export async function POST(req: Request) {
  const { caseNumber, status, note } = await req.json();
  if (!caseNumber) return NextResponse.json({ error: "caseNumber required" }, { status: 400 });
  const patch: any = { updated_at: new Date().toISOString() };
  if (status !== undefined) patch.knock_status = status;
  if (note !== undefined) patch.knock_note = note;
  const { error } = await sbClient().from("foreclosure_leads").update(patch).eq("case_number", caseNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
