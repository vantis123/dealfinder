import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

export async function GET() {
  const { data, error } = await sbClient()
    .from("foreclosure_leads")
    .select("*")
    .order("flagged", { ascending: false, nullsFirst: false })
    .order("spread", { ascending: false, nullsFirst: false });
  if (error) return NextResponse.json({ leads: [], stats: { total: 0, knock: 0, review: 0, totalEquity: 0 }, error: error.message });
  const leads = (data || []).map(toLead);
  return NextResponse.json({
    leads,
    stats: {
      total: leads.length,
      knock: leads.filter((l) => l.flagged).length,
      review: leads.filter((l) => l.reviewStatus === "manual_review").length,
      totalEquity: leads.filter((l) => l.flagged).reduce((s, l) => s + (l.spread || 0), 0),
    },
  });
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
