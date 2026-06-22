"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";
import { MapPin, FileText, FileX2, ExternalLink, Calendar, Play, Loader2 } from "lucide-react";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const NOW = new Date();

interface Lead {
  caseNumber: string;
  plaintiff: string;
  defendant: string;
  type: string;
  propertyAddress?: string | null;
  totalOwed?: number | null;
  owedWithBuffer?: number | null;
  zillowValue?: number | null;
  spread?: number | null;
  flagged?: boolean | null;
  reviewStatus?: string;
  reviewReason?: string | null;
  hasComplaint?: boolean;
  hasValue?: boolean;
  complaintUrl?: string | null;
  valueUrl?: string | null;
  docketUrl?: string | null;
  knock?: { status?: string; note?: string };
}

const KNOCK_STATUSES = [
  { key: "new", label: "New" },
  { key: "to_knock", label: "To Knock" },
  { key: "no_answer", label: "No Answer" },
  { key: "talked", label: "Talked" },
  { key: "interested", label: "Interested" },
  { key: "not_interested", label: "Not Interested" },
  { key: "follow_up", label: "Follow Up" },
  { key: "deal", label: "Deal!" },
];

const CLERK_SEARCH = "https://myeclerk.myorangeclerk.com/Cases/Search";
// reliable Google Maps place (opens the exact address; Street View peg is one click away)
const mapsUrl = (addr: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
// the property's Zillow page (the listing + Zestimate)
const zillowUrl = (addr: string) =>
  `https://www.zillow.com/homes/${encodeURIComponent(addr.replace(/,/g, "").replace(/\s+/g, "-"))}_rb/`;

export default function ForeclosuresPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState({ total: 0, knock: 0, review: 0, totalEquity: 0 });
  const [loading, setLoading] = useState(true);
  const [minSpread, setMinSpread] = useState(200000);
  const [view, setView] = useState<"knock" | "review" | "all">("knock");
  const [q, setQ] = useState("");
  // scan state
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMonth, setScanMonth] = useState(NOW.getMonth() + 1);
  const [scanYear, setScanYear] = useState(NOW.getFullYear());
  const [scan, setScan] = useState<{
    running?: boolean; done?: number; total?: number; month?: number; year?: number;
    knock?: number; review?: number; mode?: string; aiCostUsd?: number;
    recent?: { caseNumber: string; address?: string | null; spread?: number | null; flagged?: boolean; x?: boolean }[];
  } | null>(null);

  useEffect(() => { load(); pollScan(); }, []);
  async function load() {
    try {
      const res = await fetch("/api/foreclosures");
      const data = await res.json();
      setLeads(data.leads || []);
      setStats(data.stats || { total: 0, knock: 0, review: 0, totalEquity: 0 });
    } finally { setLoading(false); }
  }
  async function pollScan() {
    try {
      const s = await (await fetch("/api/foreclosures/scan")).json();
      setScan(s);
      load(); // refresh the board live as leads come in (option 3: work the list while it fills)
      setTimeout(pollScan, s?.running ? 3500 : 12000); // keep polling forever; faster while scanning
    } catch { setTimeout(pollScan, 8000); }
  }
  // while a scan is running, show "All" so tiles visibly populate as they're found
  useEffect(() => { if (scan?.running) setView("all"); }, [scan?.running]);
  async function runScan() {
    const res = await fetch("/api/foreclosures/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month: scanMonth, year: scanYear }),
    });
    if (res.ok) { setScanOpen(false); setScan({ running: true, done: 0, total: 0, month: scanMonth, year: scanYear }); setTimeout(pollScan, 3000); }
    else { const e = await res.json(); alert(e.error || "Could not start scan"); }
  }

  async function setKnock(caseNumber: string, status: string) {
    setLeads((ls) => ls.map((l) => (l.caseNumber === caseNumber ? { ...l, knock: { ...l.knock, status } } : l)));
    await fetch("/api/foreclosures", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseNumber, status }),
    });
  }

  const filtered = leads.filter((l) => {
    if (view === "knock" && !l.flagged) return false;
    if (view === "review" && l.reviewStatus !== "manual_review") return false;
    if (view === "knock" && (l.spread || 0) < minSpread) return false;
    if (q && !(`${l.propertyAddress} ${l.defendant} ${l.plaintiff} ${l.caseNumber}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 ml-64">
        <Header title="Foreclosure Leads" totalProperties={stats.total} hotDeals={stats.knock}
          onRefresh={() => setScanOpen((v) => !v)} isRefreshing={scan?.running} />

        {/* Scan controls / progress */}
        {(scanOpen || scan?.running) && (
          <div className="px-6 py-3 border-b border-border bg-card/40">
            {scan?.running ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>Scanning <b>{MONTHS[(scan.month || 1) - 1]} {scan.year}</b> — <b>{scan.done || 0}/{scan.total || "…"}</b></span>
                  <span className="text-emerald-400">🚪 {scan.knock || 0} knock</span>
                  <span className="text-amber-400">⚠ {scan.review || 0} review</span>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">
                    {scan.mode === "ai" ? `AI · $${(scan.aiCostUsd || 0).toFixed(3)}` : "OCR · $0 (no AI)"}
                  </span>
                  <div className="flex-1 min-w-[120px] max-w-md h-2 rounded bg-muted overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: `${scan.total ? Math.round(((scan.done || 0) / scan.total) * 100) : 5}%` }} />
                  </div>
                </div>
                {/* live findings feed */}
                {scan.recent && scan.recent.length > 0 && (
                  <div className="text-xs space-y-0.5 max-h-28 overflow-y-auto font-mono">
                    {scan.recent.map((f) => (
                      <div key={f.caseNumber} className={f.flagged ? "text-emerald-400" : f.x ? "text-red-400" : "text-muted-foreground"}>
                        {f.flagged ? "🚪" : f.x ? "✗" : "·"} {f.address || f.caseNumber}
                        {f.spread != null && <span> — {formatCurrency(f.spread)}{f.flagged ? " KNOCK" : ""}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Scan which month?</span>
                <select value={scanMonth} onChange={(e) => setScanMonth(Number(e.target.value))}
                  className="rounded-lg border border-border bg-background px-2 py-1.5">
                  {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
                <select value={scanYear} onChange={(e) => setScanYear(Number(e.target.value))}
                  className="rounded-lg border border-border bg-background px-2 py-1.5">
                  {[NOW.getFullYear(), NOW.getFullYear() - 1, NOW.getFullYear() - 2].map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <button onClick={runScan}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90">
                  <Play className="h-4 w-4" /> Run Scan
                </button>
                <button onClick={() => setScanOpen(false)} className="text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            )}
          </div>
        )}

        {/* Stats */}
        <div className="flex items-center gap-8 px-6 py-4 border-b border-border">
          <Stat label="Total CA Filings" value={String(stats.total)} />
          <Stat label="Worth Knocking" value={String(stats.knock)} accent="text-emerald-400" />
          <Stat label="Need Manual Review" value={String(stats.review)} accent="text-amber-400" />
          <Stat label="Total Equity in Play" value={formatCurrency(stats.totalEquity)} accent="text-primary" />
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-border">
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {([["knock", "🚪 Knock List"], ["review", "⚠ Review"], ["all", "All"]] as const).map(([k, lbl]) => (
              <button key={k} onClick={() => setView(k)}
                className={cn("px-3 py-1.5", view === k ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>
                {lbl}
              </button>
            ))}
          </div>
          {view === "knock" && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Min spread
              <input type="range" min={0} max={1000000} step={25000} value={minSpread}
                onChange={(e) => setMinSpread(Number(e.target.value))} className="accent-primary" />
              <span className="font-semibold text-foreground w-20">{formatCurrency(minSpread)}</span>
            </label>
          )}
          <input placeholder="Search address / owner / case…" value={q} onChange={(e) => setQ(e.target.value)}
            className="ml-auto rounded-lg border border-border bg-background px-3 py-1.5 text-sm w-64" />
        </div>

        {/* Cards */}
        <div className="p-6">
          {loading ? <p className="text-muted-foreground">Loading leads…</p> :
            filtered.length === 0 ? <p className="text-muted-foreground">No leads in this view yet. The monthly pull populates them.</p> :
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map((l) => <LeadCard key={l.caseNumber} l={l} onKnock={setKnock} />)}
            </div>}
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-bold", accent)}>{value}</p>
    </div>
  );
}

function LeadCard({ l, onKnock }: { l: Lead; onKnock: (c: string, s: string) => void }) {
  const flagged = !!l.flagged;
  const review = l.reviewStatus === "manual_review";
  return (
    <Card className={cn("p-4 border-l-4", flagged ? "border-l-emerald-500" : review ? "border-l-amber-500" : "border-l-border")}>
      {/* Spread headline */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Equity spread</p>
          <p className={cn("text-2xl font-extrabold", flagged ? "text-emerald-400" : "text-muted-foreground")}>
            {l.spread != null ? formatCurrency(l.spread) : "—"}
          </p>
        </div>
        {flagged ? <Badge className="bg-emerald-500/15 text-emerald-400 border-0">🚪 KNOCK</Badge>
          : review ? <Badge className="bg-amber-500/15 text-amber-400 border-0">⚠ REVIEW</Badge>
          : <Badge className="bg-muted text-muted-foreground border-0">—</Badge>}
      </div>

      {/* Address */}
      <a href={l.propertyAddress ? mapsUrl(l.propertyAddress) : CLERK_SEARCH} target="_blank" rel="noreferrer"
        className="mt-3 flex items-center gap-1.5 text-sm font-medium hover:text-primary">
        <MapPin className="h-4 w-4 flex-shrink-0" />
        {l.propertyAddress || <span className="italic text-muted-foreground">address not pulled</span>}
        <ExternalLink className="h-3 w-3 opacity-50" />
      </a>
      {/* Map / Street View / Zillow quick links */}
      {l.propertyAddress && (
        <div className="mt-1.5 flex gap-2 text-xs">
          <a href={mapsUrl(l.propertyAddress)} target="_blank" rel="noreferrer" className="text-primary hover:underline">📍 Map / Street View</a>
          <a href={zillowUrl(l.propertyAddress)} target="_blank" rel="noreferrer" className="text-primary hover:underline">🏠 Zillow listing</a>
        </div>
      )}

      {/* Parties + numbers */}
      <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
        <p><span className="text-foreground font-medium">{l.defendant || "—"}</span> &nbsp;·&nbsp; {l.plaintiff}</p>
        <p>{l.caseNumber} &nbsp;·&nbsp; {l.type}</p>
      </div>
      <div className="mt-2 flex gap-4 text-sm">
        <span>Owed <b>{l.owedWithBuffer != null ? formatCurrency(l.owedWithBuffer) : "—"}</b></span>
        <span>Zillow <b>{l.zillowValue != null ? formatCurrency(l.zillowValue) : "—"}</b></span>
      </div>

      {/* Documents — X when not accessible */}
      <div className="mt-3 flex gap-2">
        <DocChip ok={!!l.hasComplaint} label="Complaint" href={l.complaintUrl || undefined} />
        <DocChip ok={!!l.hasValue} label="Value" href={l.valueUrl || undefined} />
        {(!l.hasComplaint || !l.hasValue) && (
          <a href={CLERK_SEARCH} target="_blank" rel="noreferrer"
            className="ml-auto text-xs text-amber-400 hover:underline flex items-center gap-1">
            Pull manually <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Knock status */}
      <div className="mt-3 pt-3 border-t border-border">
        <select value={l.knock?.status || "new"} onChange={(e) => onKnock(l.caseNumber, e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
          {KNOCK_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>
    </Card>
  );
}

function DocChip({ ok, label, href }: { ok: boolean; label: string; href?: string }) {
  if (!ok) return (
    <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 text-red-400 px-2 py-1 text-xs font-medium">
      <FileX2 className="h-3.5 w-3.5" /> {label} <b className="ml-0.5">X</b>
    </span>
  );
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-md bg-primary/10 text-primary px-2 py-1 text-xs font-medium hover:bg-primary/20">
      <FileText className="h-3.5 w-3.5" /> {label}
    </a>
  );
}
