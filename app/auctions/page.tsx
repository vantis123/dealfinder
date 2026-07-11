"use client";

import { useEffect, useState } from "react";
import { AUCTION_COUNTIES } from "@/lib/counties";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";
import { MapPin, ExternalLink, CalendarClock, Gavel, Loader2, FileText } from "lucide-react";

// Auction listing pulled from the RealForeclose (RealAuction) calendars.
// Distinct from Foreclosure Leads (clerk pre-foreclosure filings) — this is the AUCTION stage.
interface Auction {
  caseNumber: string;
  county: string;                 // Seminole | Orange | Volusia
  auctionDate?: string | null;    // scheduled sale date
  auctionStatus?: string | null;  // Scheduled | Canceled per Bankruptcy | Sold | Rescheduled
  finalJudgment?: number | null;  // Final Judgment Amount (primary)
  unpaidPrincipal?: number | null;// from the Final Judgment PDF (enrichment)
  parcelId?: string | null;
  propertyAddress?: string | null;
  assessedValue?: number | null;
  zillowValue?: number | null;
  spread?: number | null;         // value - judgment
  flagged?: boolean | null;       // spread >= threshold
  judgmentUrl?: string | null;    // RealForeclose listing detail link
  saleDate?: string | null;       // Notice of Sale date (from clerk docket / future event)
  saleLocation?: string | null;
  valueSheetUrl?: string | null;  // saved value sheet PDF (Seminole)
  noticeOfSaleUrl?: string | null;// saved Notice of Sale PDF
  finalJudgmentUrl?: string | null;// saved Final Judgment PDF (Orange)
  interestOwed?: number | null;
  foundAt?: string | null;        // when the scan first found it
}

const COUNTIES = ["All", ...AUCTION_COUNTIES] as const;
const mapsUrl = (a: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
const zillowUrl = (a: string) => `https://www.zillow.com/homes/${encodeURIComponent(a.replace(/,/g, "").replace(/\s+/g, "-"))}_rb/`;
const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "—";
const foundOn = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
const isCancelled = (s?: string | null) => /cancel|bankruptc/i.test(s || "");

export default function AuctionsPage() {
  const [rows, setRows] = useState<Auction[]>([]);
  const [loading, setLoading] = useState(true);
  const [county, setCounty] = useState<(typeof COUNTIES)[number]>("All");
  const [minSpread, setMinSpread] = useState(100000); // Phillip's auction equity floor
  const [view, setView] = useState<"upcoming" | "cancelled" | "all">("upcoming");
  const [q, setQ] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/auctions");
        if (r.ok) setRows(await r.json());
      } catch {
        /* scraper not run yet — empty state */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = rows
    .filter((a) => (county === "All" ? true : a.county === county))
    .filter((a) =>
      view === "all" ? true : view === "cancelled" ? isCancelled(a.auctionStatus) : !isCancelled(a.auctionStatus)
    )
    .filter((a) => (a.spread == null ? true : a.spread >= minSpread))
    .filter((a) =>
      !q ? true : `${a.caseNumber} ${a.propertyAddress ?? ""} ${a.county}`.toLowerCase().includes(q.toLowerCase())
    )
    .sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0) || (b.spread ?? 0) - (a.spread ?? 0));

  const stats = {
    total: rows.length,
    knock: rows.filter((a) => a.flagged && !isCancelled(a.auctionStatus)).length,
    equity: rows.reduce((s, a) => s + Math.max(0, a.spread ?? 0), 0),
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 lg:ml-64">
        <Header title="Auctions" totalProperties={stats.total} hotDeals={stats.knock} />

        <div className="p-6 space-y-6">
          {/* Stat cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Upcoming Auctions</p>
              <p className="mt-1 text-2xl font-bold">{rows.filter((a) => !isCancelled(a.auctionStatus)).length}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">$100K+ Equity</p>
              <p className="mt-1 text-2xl font-bold text-primary">{stats.knock}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Total Equity in Play</p>
              <p className="mt-1 text-2xl font-bold">{formatCurrency(stats.equity)}</p>
            </Card>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {COUNTIES.map((c) => (
              <button
                key={c}
                onClick={() => setCounty(c)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                  county === c ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground"
                )}
              >
                {c}
              </button>
            ))}
            <div className="mx-2 h-5 w-px bg-border" />
            {(["upcoming", "cancelled", "all"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                  view === v ? "bg-primary/10 text-primary" : "bg-accent text-muted-foreground hover:text-foreground"
                )}
              >
                {v}
              </button>
            ))}
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search case # or address…"
              className="ml-auto w-56 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            />
          </div>

          {/* List */}
          {loading ? (
            <div className="flex items-center gap-2 py-20 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading auctions…
            </div>
          ) : filtered.length === 0 ? (
            <Card className="flex flex-col items-center gap-3 py-16 text-center">
              <CalendarClock className="h-10 w-10 text-muted-foreground" />
              <p className="text-lg font-semibold">No auctions yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Auction listings populate when the <span className="font-medium">RealForeclose</span> scan runs — it walks
                the Seminole, Orange & Volusia auction calendars for every future sale date and pulls each Final Judgment
                amount, skipping timeshares and flagging $100K+ equity.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {filtered.map((a) => (
                <Card key={a.caseNumber + a.county} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{a.county}</Badge>
                        <span className="font-mono text-sm text-muted-foreground">{a.caseNumber}</span>
                        {a.flagged && !isCancelled(a.auctionStatus) && <Badge className="bg-primary">KNOCK</Badge>}
                        {isCancelled(a.auctionStatus) && <Badge variant="secondary">{a.auctionStatus}</Badge>}
                      </div>
                      <p className="mt-1 truncate font-medium">{a.propertyAddress || "Address pending"}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <CalendarClock className="h-4 w-4" /> Sale {fmtDate(a.saleDate || a.auctionDate)}
                        </span>
                        {foundOn(a.foundAt) && <span>found {foundOn(a.foundAt)}</span>}
                        {a.parcelId && <span>Parcel {a.parcelId}</span>}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-muted-foreground">Final Judgment</p>
                      <p className="text-lg font-bold">{a.finalJudgment != null ? formatCurrency(a.finalJudgment) : "—"}</p>
                      {a.spread != null && (
                        <p className={cn("text-sm font-medium", a.spread >= minSpread ? "text-primary" : "text-muted-foreground")}>
                          {formatCurrency(a.spread)} equity
                        </p>
                      )}
                      {a.unpaidPrincipal != null && (
                        <p className="mt-0.5 text-xs text-muted-foreground">Principal {formatCurrency(a.unpaidPrincipal)}</p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                    {a.propertyAddress && (
                      <>
                        <a className="inline-flex items-center gap-1 text-primary hover:underline" href={mapsUrl(a.propertyAddress)} target="_blank" rel="noreferrer">
                          <MapPin className="h-4 w-4" /> Map
                        </a>
                        <a className="inline-flex items-center gap-1 text-primary hover:underline" href={zillowUrl(a.propertyAddress)} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-4 w-4" /> Zillow
                        </a>
                      </>
                    )}
                    {a.finalJudgmentUrl && (
                      <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={a.finalJudgmentUrl} target="_blank" rel="noreferrer">
                        <FileText className="h-4 w-4" /> Final Judgment PDF
                      </a>
                    )}
                    {a.valueSheetUrl && (
                      <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={a.valueSheetUrl} target="_blank" rel="noreferrer">
                        <FileText className="h-4 w-4" /> Value Sheet
                      </a>
                    )}
                    {a.noticeOfSaleUrl && (
                      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={a.noticeOfSaleUrl} target="_blank" rel="noreferrer">
                        <FileText className="h-4 w-4" /> Notice of Sale
                      </a>
                    )}
                    {a.judgmentUrl && (
                      <a className="inline-flex items-center gap-1 text-muted-foreground hover:underline" href={a.judgmentUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" /> Listing
                      </a>
                    )}
                    {a.assessedValue != null && <span className="text-muted-foreground">Assessed {formatCurrency(a.assessedValue)}</span>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
