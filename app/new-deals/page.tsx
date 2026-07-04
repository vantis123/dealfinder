"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";
import { Flame, MapPin, ExternalLink, CalendarClock, Loader2, Sparkles } from "lucide-react";

// The "extra heavy" tab: newest finds worth a real split, across BOTH sources
// (pre-foreclosure clerk leads + RealForeclose auctions), best split first.
interface Deal {
  caseNumber: string;
  source: "auction" | "clerk";          // where it came from
  county: string;
  propertyAddress?: string | null;
  owed?: number | null;                  // judgment / owed
  value?: number | null;                 // zillow / assessed
  spread?: number | null;                // value - owed
  auctionDate?: string | null;           // auctions only
  status?: string | null;
  foundAt?: string | null;               // when the scan first found it
}

const SPLIT_OPTIONS = [100000, 150000, 200000, 300000];
const mapsUrl = (a: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
const zillowUrl = (a: string) => `https://www.zillow.com/homes/${encodeURIComponent(a.replace(/,/g, "").replace(/\s+/g, "-"))}_rb/`;
const daysAgo = (d?: string | null) => {
  if (!d) return null;
  const n = Math.round((Date.now() - new Date(d).getTime()) / 86400000);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n}d ago`;
};
const foundOn = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

export default function NewDealsPage() {
  const [rows, setRows] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [minSplit, setMinSplit] = useState(100000); // "reasonable split to make"
  const [source, setSource] = useState<"all" | "auction" | "clerk">("all");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/new-deals");
        if (r.ok) setRows(await r.json());
      } catch {
        /* scrapers not run yet */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const deals = rows
    .filter((d) => (source === "all" ? true : d.source === source))
    .filter((d) => (d.spread ?? 0) >= minSplit)
    .sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0));

  const topSplit = deals[0]?.spread ?? 0;
  const totalSplit = deals.reduce((s, d) => s + Math.max(0, d.spread ?? 0), 0);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 ml-64">
        <Header title="New Deals" totalProperties={deals.length} hotDeals={deals.length} />

        <div className="p-6 space-y-6">
          {/* Heavy hero banner */}
          <div className="rounded-xl border border-primary/40 bg-gradient-to-r from-primary/15 to-primary/5 p-5">
            <div className="flex items-center gap-2 text-primary">
              <Flame className="h-6 w-6" />
              <h2 className="text-xl font-bold">Freshest deals worth the split</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Newly-found foreclosures — pre-foreclosure filings + auction listings — with at least{" "}
              <span className="font-semibold text-foreground">{formatCurrency(minSplit)}</span> equity, best split first.
            </p>
            <div className="mt-4 flex flex-wrap gap-6">
              <div>
                <p className="text-xs text-muted-foreground">Deals</p>
                <p className="text-2xl font-bold">{deals.length}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Best Split</p>
                <p className="text-2xl font-bold text-primary">{formatCurrency(topSplit)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Split Available</p>
                <p className="text-2xl font-bold">{formatCurrency(totalSplit)}</p>
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Min split:</span>
            {SPLIT_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setMinSplit(s)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                  minSplit === s ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground"
                )}
              >
                {formatCurrency(s)}+
              </button>
            ))}
            <div className="mx-2 h-5 w-px bg-border" />
            {(["all", "clerk", "auction"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSource(s)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                  source === s ? "bg-primary/10 text-primary" : "bg-accent text-muted-foreground hover:text-foreground"
                )}
              >
                {s === "clerk" ? "Pre-Foreclosure" : s === "auction" ? "Auction" : "All"}
              </button>
            ))}
          </div>

          {/* List */}
          {loading ? (
            <div className="flex items-center gap-2 py-20 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading new deals…
            </div>
          ) : deals.length === 0 ? (
            <Card className="flex flex-col items-center gap-3 py-16 text-center">
              <Sparkles className="h-10 w-10 text-muted-foreground" />
              <p className="text-lg font-semibold">No new deals yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                This tab lights up as the scans find fresh foreclosures with at least {formatCurrency(minSplit)} of equity —
                the ones actually worth chasing. Run the foreclosure and RealForeclose scans to fill it.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {deals.map((d) => (
                <Card key={d.source + d.caseNumber} className="border-l-4 border-l-primary p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={d.source === "auction" ? "default" : "secondary"}>
                          {d.source === "auction" ? "Auction" : "Pre-Foreclosure"}
                        </Badge>
                        <Badge variant="outline">{d.county}</Badge>
                        <span className="font-mono text-sm text-muted-foreground">{d.caseNumber}</span>
                        {daysAgo(d.foundAt) && <span className="text-xs text-primary">• found {daysAgo(d.foundAt)}{foundOn(d.foundAt) ? ` · ${foundOn(d.foundAt)}` : ""}</span>}
                      </div>
                      <p className="mt-1 truncate font-medium">{d.propertyAddress || "Address pending"}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-4 text-sm text-muted-foreground">
                        {d.owed != null && <span>Owed {formatCurrency(d.owed)}</span>}
                        {d.value != null && <span>Value {formatCurrency(d.value)}</span>}
                        {d.auctionDate && (
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="h-4 w-4" /> {new Date(d.auctionDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-muted-foreground">Split</p>
                      <p className="text-2xl font-bold text-primary">{formatCurrency(d.spread ?? 0)}</p>
                    </div>
                  </div>
                  {d.propertyAddress && (
                    <div className="mt-3 flex items-center gap-3 text-sm">
                      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={mapsUrl(d.propertyAddress)} target="_blank" rel="noreferrer">
                        <MapPin className="h-4 w-4" /> Map
                      </a>
                      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={zillowUrl(d.propertyAddress)} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" /> Zillow
                      </a>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
