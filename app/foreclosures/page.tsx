"use client";

import { useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";
import { MapPin, FileText, FileX2, ExternalLink, Calendar, Play, Loader2, Table2, LayoutGrid } from "lucide-react";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const NOW = new Date();
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const MONTH_START = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-01`;
const TODAY_ISO = isoDate(NOW);

interface ScanSummary {
  county?: string; month?: number; year?: number; from?: string; to?: string; total?: number;
  knock?: number; review?: number; notWorth?: number; pipelineAdded?: number;
}

interface Lead {
  caseNumber: string;
  plaintiff: string;
  defendant: string;
  type: string;
  county?: string;
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
  phones?: { phone: string; sources: string[] }[];
  skiptraceName?: string | null;
  filingDate?: string | null;
  scannedAt?: string | null;
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
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const [sortBy, setSortBy] = useState<"spread" | "filed" | "found">("spread");
  const [q, setQ] = useState("");
  // scan state
  const [scanOpen, setScanOpen] = useState(false);
  const [scanCounty, setScanCounty] = useState<"Orange" | "Seminole">("Orange");
  const [scanFrom, setScanFrom] = useState(MONTH_START);
  const [scanTo, setScanTo] = useState(TODAY_ISO);
  const [summary, setSummary] = useState<ScanSummary | null>(null); // scan / daily-update overlay
  const seenFinish = useRef<string | null>(null);
  const [scan, setScan] = useState<{
    running?: boolean; done?: number; total?: number; month?: number; year?: number; from?: string; to?: string; county?: string;
    knock?: number; review?: number; notWorth?: number; pipelineAdded?: number; mode?: string; aiCostUsd?: number; finishedAt?: string;
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
      // Show the summary overlay the first time we see a freshly-finished scan — covers both an in-session
      // scan completing AND a user logging in after the daily cron ran (the "daily update").
      if (s && !s.running && s.finishedAt) {
        const recent = Date.now() - new Date(s.finishedAt).getTime() < 24 * 3600 * 1000;
        const lastSeen = seenFinish.current ?? (typeof window !== "undefined" ? localStorage.getItem("df_lastScanSeen") : null);
        if (recent && s.finishedAt !== lastSeen) {
          seenFinish.current = s.finishedAt;
          if (typeof window !== "undefined") localStorage.setItem("df_lastScanSeen", s.finishedAt);
          setSummary({
            county: s.county, from: s.from, to: s.to, month: s.month, year: s.year, total: s.total ?? s.done,
            knock: s.knock, review: s.review,
            notWorth: s.notWorth ?? Math.max(0, (s.total ?? s.done ?? 0) - (s.knock ?? 0) - (s.review ?? 0)),
            pipelineAdded: s.pipelineAdded,
          });
        }
      }
      setTimeout(pollScan, s?.running ? 3500 : 12000); // keep polling forever; faster while scanning
    } catch { setTimeout(pollScan, 8000); }
  }
  // while a scan is running, show "All" so tiles visibly populate as they're found
  useEffect(() => { if (scan?.running) setView("all"); }, [scan?.running]);
  async function runScan() {
    const res = await fetch("/api/foreclosures/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ county: scanCounty, from: scanFrom, to: scanTo }),
    });
    if (res.ok) { setScanOpen(false); setScan({ running: true, done: 0, total: 0, county: scanCounty, from: scanFrom, to: scanTo }); setTimeout(pollScan, 3000); }
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
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "filed") return (b.filingDate || "").localeCompare(a.filingDate || "");
    if (sortBy === "found") return (b.scannedAt || "").localeCompare(a.scannedAt || "");
    return (b.spread ?? -Infinity) - (a.spread ?? -Infinity);
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
                  <span>Scanning <b>{scan.county || "Orange"}</b> · <b>{scan.from && scan.to ? `${scan.from} → ${scan.to}` : `${MONTHS[(scan.month || 1) - 1]} ${scan.year}`}</b> — <b>{scan.done || 0}/{scan.total || "…"}</b></span>
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
                <span className="text-muted-foreground">County</span>
                <select value={scanCounty} onChange={(e) => setScanCounty(e.target.value as "Orange" | "Seminole")}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 font-medium">
                  <option value="Orange">Orange</option>
                  <option value="Seminole">Seminole</option>
                </select>
                <span className="text-muted-foreground">from</span>
                <input type="date" value={scanFrom} max={scanTo} onChange={(e) => setScanFrom(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2 py-1.5" />
                <span className="text-muted-foreground">to</span>
                <input type="date" value={scanTo} min={scanFrom} max={TODAY_ISO} onChange={(e) => setScanTo(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2 py-1.5" />
                <div className="flex gap-1">
                  <button onClick={() => { setScanFrom(TODAY_ISO); setScanTo(TODAY_ISO); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-accent">Today</button>
                  <button onClick={() => { const f = new Date(); f.setDate(f.getDate() - 7); setScanFrom(isoDate(f)); setScanTo(TODAY_ISO); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-accent">7d</button>
                  <button onClick={() => { const f = new Date(); f.setDate(f.getDate() - 30); setScanFrom(isoDate(f)); setScanTo(TODAY_ISO); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-accent">30d</button>
                  <button onClick={() => { setScanFrom(MONTH_START); setScanTo(TODAY_ISO); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-accent">Month</button>
                </div>
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
          <Stat label="Total Filings" value={String(stats.total)} />
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
          <div className="ml-auto flex items-center gap-3">
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "spread" | "filed" | "found")}
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm" title="Sort by">
              <option value="spread">Sort: Spread</option>
              <option value="filed">Sort: Filing date (newest)</option>
              <option value="found">Sort: Found date (newest)</option>
            </select>
            <div className="flex rounded-lg border border-border overflow-hidden text-sm">
              <button onClick={() => setViewMode("table")} title="Table view"
                className={cn("px-2.5 py-1.5 flex items-center gap-1", viewMode === "table" ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>
                <Table2 className="h-4 w-4" /> Table
              </button>
              <button onClick={() => setViewMode("cards")} title="Card view"
                className={cn("px-2.5 py-1.5 flex items-center gap-1", viewMode === "cards" ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>
                <LayoutGrid className="h-4 w-4" /> Cards
              </button>
            </div>
            <input placeholder="Search address / owner / case…" value={q} onChange={(e) => setQ(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm w-64" />
          </div>
        </div>

        {/* Leads */}
        <div className="p-6">
          {loading ? <p className="text-muted-foreground">Loading leads…</p> :
            sorted.length === 0 ? <p className="text-muted-foreground">No leads in this view yet. Run a scan to populate them.</p> :
            viewMode === "table" ? <LeadTable leads={sorted} onKnock={setKnock} /> :
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {sorted.map((l) => <LeadCard key={l.caseNumber} l={l} onKnock={setKnock} />)}
            </div>}
        </div>

        {/* Post-scan summary overlay */}
        {summary && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setSummary(null)}>
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-lg font-bold">Latest scan ✓</h2>
              <p className="text-xs text-muted-foreground mb-4">
                <b className="text-foreground">{summary.county || "Orange"}</b>
                {summary.from && summary.to ? ` · ${summary.from} → ${summary.to}` : summary.month ? ` · ${MONTHS[summary.month - 1]} ${summary.year}` : ""} · {summary.total ?? 0} cases scanned
              </p>
              <div className="grid grid-cols-3 gap-3">
                <SumStat n={summary.knock ?? 0} label="Doors to knock" emoji="🚪" accent="text-emerald-400" />
                <SumStat n={summary.review ?? 0} label="Manual review" emoji="⚠" accent="text-amber-400" />
                <SumStat n={summary.notWorth ?? 0} label="Not worth it" emoji="✗" accent="text-muted-foreground" />
              </div>
              <div className="mt-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-4 text-center">
                <p className="text-xs text-muted-foreground">Added to pipeline</p>
                <p className="text-3xl font-extrabold text-emerald-400">{formatCurrency(summary.pipelineAdded ?? 0)}</p>
              </div>
              <button onClick={() => setSummary(null)}
                className="mt-5 w-full rounded-lg bg-primary py-2.5 font-medium text-primary-foreground hover:opacity-90">
                View leads
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function SumStat({ n, label, emoji, accent }: { n: number; label: string; emoji: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3 text-center">
      <p className={cn("text-2xl font-extrabold", accent)}>{n}</p>
      <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{emoji} {label}</p>
    </div>
  );
}

function LeadTable({ leads, onKnock }: { leads: Lead[]; onKnock: (c: string, s: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-card/60 text-xs uppercase tracking-wide text-muted-foreground sticky top-0">
          <tr className="text-left">
            <th className="px-3 py-2.5 font-medium">Spread</th>
            <th className="px-3 py-2.5 font-medium">Property</th>
            <th className="px-3 py-2.5 font-medium text-right">Owed</th>
            <th className="px-3 py-2.5 font-medium text-right">Zillow</th>
            <th className="px-3 py-2.5 font-medium">Owner / Bank</th>
            <th className="px-3 py-2.5 font-medium">Links</th>
            <th className="px-3 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => <LeadRow key={l.caseNumber} l={l} onKnock={onKnock} />)}
        </tbody>
      </table>
    </div>
  );
}

function LeadRow({ l, onKnock }: { l: Lead; onKnock: (c: string, s: string) => void }) {
  const flagged = !!l.flagged;
  const review = l.reviewStatus === "manual_review";
  return (
    <tr className={cn("border-t border-border hover:bg-accent/40 align-top",
      flagged && "bg-emerald-500/[0.05]", review && !flagged && "bg-amber-500/[0.04]")}>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span className={cn("font-bold text-base", flagged ? "text-emerald-400" : review ? "text-amber-400/80" : "text-muted-foreground")}>
          {l.spread != null ? formatCurrency(l.spread) : "—"}
        </span>
        {flagged && <span className="ml-1.5 text-xs">🚪</span>}
      </td>
      <td className="px-3 py-2.5 max-w-[280px]">
        {l.propertyAddress ? (
          <a href={mapsUrl(l.propertyAddress)} target="_blank" rel="noreferrer" className="font-medium hover:text-primary inline-flex items-start gap-1">
            <MapPin className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 opacity-50" />{l.propertyAddress}
          </a>
        ) : <span className="italic text-muted-foreground">address not pulled</span>}
        <div className="text-[11px] text-muted-foreground mt-0.5">{l.caseNumber}{l.county ? ` · ${l.county}` : ""}{l.filingDate ? ` · 📅 filed ${l.filingDate}` : ""}</div>
      </td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap">{l.owedWithBuffer != null ? formatCurrency(l.owedWithBuffer) : "—"}</td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap">{l.zillowValue != null ? formatCurrency(l.zillowValue) : "—"}</td>
      <td className="px-3 py-2.5 max-w-[210px]">
        <div className="truncate font-medium text-foreground">{l.defendant || "—"}</div>
        <div className="truncate text-[11px] text-muted-foreground">{l.plaintiff}</div>
        {l.phones && l.phones.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {l.phones.slice(0, 3).map((ph, i) => (
              <a key={i} href={`tel:${ph.phone.replace(/\D/g, "")}`} title={ph.sources.join(" + ")}
                className="text-xs font-medium text-emerald-400 hover:underline">
                📞 {ph.phone}{ph.sources.length > 1 ? " ✓✓" : ""}
              </a>
            ))}
            {l.phones.length > 3 && <span className="text-[10px] text-muted-foreground">+{l.phones.length - 3} more</span>}
            {l.skiptraceName && <span className="text-[10px] text-muted-foreground truncate">({l.skiptraceName})</span>}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-sm">
        <div className="flex items-center gap-2">
          {l.propertyAddress && <a href={mapsUrl(l.propertyAddress)} target="_blank" rel="noreferrer" title="Map / Street View" className="hover:opacity-70">📍</a>}
          {l.propertyAddress && <a href={zillowUrl(l.propertyAddress)} target="_blank" rel="noreferrer" title="Zillow" className="hover:opacity-70">🏠</a>}
          {l.complaintUrl ? <a href={l.complaintUrl} target="_blank" rel="noreferrer" title="Complaint" className="text-primary font-semibold text-xs hover:underline">C</a> : <span title="No complaint" className="text-red-400/60 text-xs">C</span>}
          {l.valueUrl ? <a href={l.valueUrl} target="_blank" rel="noreferrer" title="Value sheet" className="text-primary font-semibold text-xs hover:underline">V</a> : <span title="No value sheet" className="text-red-400/60 text-xs">V</span>}
          {l.docketUrl && <a href={l.docketUrl} target="_blank" rel="noreferrer" title="Docket" className="text-muted-foreground text-xs hover:text-primary">D</a>}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <select value={l.knock?.status || "new"} onChange={(e) => onKnock(l.caseNumber, e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs">
          {KNOCK_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </td>
    </tr>
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
        <p>{l.caseNumber} &nbsp;·&nbsp; {l.type}{l.filingDate ? ` · 📅 filed ${l.filingDate}` : ""}</p>
      </div>

      {/* Skip-trace phones */}
      {l.phones && l.phones.length > 0 && (
        <div className="mt-2 rounded-lg bg-emerald-500/5 border border-emerald-500/15 p-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {l.phones.slice(0, 4).map((ph, i) => (
              <a key={i} href={`tel:${ph.phone.replace(/\D/g, "")}`} title={ph.sources.join(" + ")}
                className="text-xs font-semibold text-emerald-400 hover:underline">
                📞 {ph.phone}{ph.sources.length > 1 ? " ✓✓" : ""}
              </a>
            ))}
          </div>
          {l.skiptraceName && <p className="mt-0.5 text-[10px] text-muted-foreground">contact: {l.skiptraceName}</p>}
        </div>
      )}

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
