"use client";

import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";
import { countyOptions } from "@/lib/counties";
import { MapPin, ExternalLink, CalendarClock, Copy, Loader2, Phone, X, MessageSquare, Route, DoorOpen, FileText, ChevronUp, ChevronDown, Sparkles } from "lucide-react";

// CRM V2 — GHL-style. Separate PIPELINE per source (switch at top); Kanban columns = that
// source's stages; click a card → detail drawer with quick actions + stage change. Automation
// hooks are placeholders (wired later). Reads the unified `deals` spine.
interface Deal {
  id: string; source: "preforeclosure" | "auction"; caseNumber: string; county: string;
  propertyAddress: string | null; value: number | null; owed: number | null; spread: number | null;
  stage: string; status: string; flagged: boolean | null; auctionDate: string | null;
  phones: string | null; skiptraceName?: string | null; duplicate: boolean; note: string | null; sourceUrl: string | null;
  foundAt?: string | null;
}

const PIPELINES = {
  preforeclosure: { label: "Pre-Foreclosure", stages: ["New", "To Knock", "No Answer", "Talked", "Follow Up", "Interested", "Negotiating", "Under Contract", "Assigned", "Paid", "Dead", "Review"] },
  auction: { label: "Auction", stages: ["New", "Researching", "Watching", "Bid-Ready", "Won", "Post-Sale", "Under Contract", "Assigned", "Paid", "Lost", "Cancelled", "Sold", "Rescheduled"] },
} as const;
type Source = keyof typeof PIPELINES;

const mapsUrl = (a: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
const zillowUrl = (a: string) => `https://www.zillow.com/homes/${encodeURIComponent(a.replace(/,/g, "").replace(/\s+/g, "-"))}_rb/`;
const foundOn = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);

export default function CrmPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [stats, setStats] = useState({ total: 0, flagged: 0, duplicates: 0, equity: 0 });
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<Source>("preforeclosure");
  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => { try { setHidden(new Set(JSON.parse(localStorage.getItem("df_hidden_counties") || "[]"))); } catch { /* */ } }, []);
  const toggleCounty = (c: string) => setHidden((prev) => { const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); try { localStorage.setItem("df_hidden_counties", JSON.stringify([...n])); } catch { /* */ } return n; });
  const [minSpread, setMinSpread] = useState(0);
  const [sel, setSel] = useState<Deal | null>(null);

  // Door-knock route builder — collect stops, view the route embedded in-app (no leaving the site).
  const [route, setRoute] = useState<{ id: string; address: string }[]>([]);
  const [home, setHome] = useState("");
  const [showMap, setShowMap] = useState(false);
  useEffect(() => { try { setRoute(JSON.parse(localStorage.getItem("df_route") || "[]")); setHome(localStorage.getItem("df_home") || ""); } catch { /* */ } }, []);
  useEffect(() => { try { localStorage.setItem("df_route", JSON.stringify(route)); } catch { /* */ } }, [route]);
  useEffect(() => { try { localStorage.setItem("df_home", home); } catch { /* */ } }, [home]);
  const inRoute = (id: string) => route.some((r) => r.id === id);
  const toggleRoute = (d: Deal) => {
    if (!d.propertyAddress) return;
    setRoute((prev) => (prev.some((r) => r.id === d.id) ? prev.filter((r) => r.id !== d.id) : [...prev, { id: d.id, address: d.propertyAddress! }]));
  };
  // Embedded route map (stays in-app). Classic Google iframe embed — no API key required.
  const embedUrl = () => {
    const stops = route.map((r) => r.address);
    if (!stops.length) return "";
    const origin = home.trim() || stops[0];
    const dests = (home.trim() ? stops : stops.slice(1));
    const daddr = dests.map((s) => encodeURIComponent(s)).join("+to:");
    return `https://maps.google.com/maps?saddr=${encodeURIComponent(origin)}&daddr=${daddr}&output=embed`;
  };
  // Optional: hand off to the real Maps app for phone turn-by-turn navigation.
  const openInMapsApp = () => {
    if (!route.length) return;
    const stops = route.map((r) => r.address);
    const params = new URLSearchParams({ api: "1", destination: stops[stops.length - 1], travelmode: "driving" });
    if (home.trim()) params.set("origin", home.trim());
    const mids = stops.slice(0, -1);
    if (mids.length) params.set("waypoints", mids.join("|"));
    window.open(`https://www.google.com/maps/dir/?${params.toString()}`, "_blank");
  };

  // Manual reorder — drag order to taste.
  const moveStop = (i: number, dir: -1 | 1) => setRoute((prev) => {
    const a = [...prev]; const j = i + dir;
    if (j < 0 || j >= a.length) return prev;
    [a[i], a[j]] = [a[j], a[i]]; return a;
  });

  // Auto-optimize: geocode each stop (free OpenStreetMap geocoder), then nearest-neighbor order
  // from the start address so it's the shortest loop with no back-and-forth.
  const [optimizing, setOptimizing] = useState(false);
  const geocode = async (addr: string): Promise<{ lat: number; lon: number } | null> => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addr)}`, { headers: { Accept: "application/json" } });
      const j = await r.json();
      return j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null;
    } catch { return null; }
  };
  const optimizeRoute = async () => {
    if (route.length < 3 || optimizing) return;
    setOptimizing(true);
    try {
      const pts: { id: string; address: string; geo: { lat: number; lon: number } | null }[] = [];
      for (const r of route) { pts.push({ ...r, geo: await geocode(r.address) }); await new Promise((res) => setTimeout(res, 1100)); } // Nominatim ~1 req/s
      const start = home.trim() ? await geocode(home.trim()) : null;
      const located = pts.filter((p) => p.geo) as { id: string; address: string; geo: { lat: number; lon: number } }[];
      const missing = pts.filter((p) => !p.geo);
      if (located.length < 2) { setOptimizing(false); return; }
      const kx = Math.cos(((located[0].geo.lat) * Math.PI) / 180); // scale longitude at this latitude
      const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => { const dy = a.lat - b.lat, dx = (a.lon - b.lon) * kx; return dy * dy + dx * dx; };
      const remaining = [...located];
      const ordered: typeof located = [];
      let cur = start;
      if (!cur) { ordered.push(remaining.shift()!); cur = ordered[0].geo; }
      while (remaining.length) {
        let bi = 0, bd = Infinity;
        remaining.forEach((p, i) => { const d = dist(cur!, p.geo); if (d < bd) { bd = d; bi = i; } });
        const next = remaining.splice(bi, 1)[0]; ordered.push(next); cur = next.geo;
      }
      setRoute([...ordered.map(({ id, address }) => ({ id, address })), ...missing.map(({ id, address }) => ({ id, address }))]);
    } finally { setOptimizing(false); }
  };

  const load = async (src: Source) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/deals?source=${src}`);
      const d = await r.json();
      setDeals(d.deals || []);
      setStats(d.stats || { total: 0, flagged: 0, duplicates: 0, equity: 0 });
    } catch { /* empty */ } finally { setLoading(false); }
  };
  useEffect(() => { load(source); }, [source]);

  const move = async (id: string, stage: string) => {
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage } : d)));
    setSel((s) => (s && s.id === id ? { ...s, stage } : s));
    await fetch("/api/deals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, stage }) });
  };

  const counties = useMemo(() => countyOptions(deals.map((d) => d.county)), [deals]);
  const filtered = deals
    .filter((d) => !hidden.has(d.county || ""))
    .filter((d) => (minSpread ? (d.spread ?? 0) >= minSpread : true))
    .filter((d) => (!q ? true : `${d.caseNumber} ${d.propertyAddress ?? ""} ${d.county}`.toLowerCase().includes(q.toLowerCase())));

  const baseStages = PIPELINES[source].stages as readonly string[];
  const extra = Array.from(new Set(filtered.map((d) => d.stage))).filter((s) => !baseStages.includes(s));
  const columns = [...baseStages.filter((s) => filtered.some((d) => d.stage === s)), ...extra];

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 lg:ml-64">
        <Header title="CRM · V2" totalProperties={stats.total} hotDeals={stats.flagged} onRefresh={() => load(source)} isRefreshing={loading} />

        <div className="p-4 space-y-4">
          {/* pipeline switcher + filters */}
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(PIPELINES) as Source[]).map((s) => (
              <button key={s} onClick={() => setSource(s)}
                className={cn("rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                  source === s ? "bg-primary text-primary-foreground shadow-sm" : "bg-accent text-muted-foreground hover:text-foreground")}>
                {PIPELINES[s].label} Pipeline
              </button>
            ))}
            <div className="mx-1 h-5 w-px bg-border" />
            <div className="flex flex-wrap items-center gap-1" title="Click a county to hide/show it">
              {counties.filter((c) => c !== "All").map((c) => (
                <button key={c} onClick={() => toggleCounty(c)}
                  className={cn("rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                    hidden.has(c) ? "bg-accent/40 text-muted-foreground line-through" : "bg-primary/10 text-primary hover:bg-primary/20")}>
                  {c}
                </button>
              ))}
            </div>
            {[0, 100000, 200000].map((v) => (
              <button key={v} onClick={() => setMinSpread(v)}
                className={cn("rounded-full px-3 py-1.5 text-xs font-medium transition-colors", minSpread === v ? "bg-primary/10 text-primary" : "bg-accent text-muted-foreground hover:text-foreground")}>
                {v === 0 ? "Any" : `${formatCurrency(v)}+`}
              </button>
            ))}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
              className="ml-auto w-52 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" />
            <span className="text-xs text-muted-foreground">{filtered.length} deals · {formatCurrency(stats.equity)} equity</span>
          </div>

          {/* kanban board */}
          {loading ? (
            <div className="flex items-center gap-2 py-20 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading…</div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-4">
              {columns.length === 0 && <Card className="w-full py-16 text-center text-muted-foreground">No deals match.</Card>}
              {columns.map((stage) => {
                const items = filtered.filter((d) => d.stage === stage);
                return (
                  <div key={stage} className="w-72 shrink-0">
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <span className="text-sm font-semibold">{stage}</span>
                      <Badge variant="secondary">{items.length}</Badge>
                    </div>
                    <div className="space-y-2">
                      {items.map((d) => (
                        <button key={d.id} onClick={() => setSel(d)}
                          className={cn("w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/50", d.flagged && "border-l-4 border-l-primary")}>
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant="outline">{d.county}</Badge>
                            {d.spread != null && <span className={cn("text-sm font-bold", d.flagged ? "text-primary" : "text-muted-foreground")}>{formatCurrency(d.spread)}</span>}
                          </div>
                          <p className="mt-1 truncate text-sm font-medium">{d.propertyAddress || "Address pending"}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span className="font-mono">{d.caseNumber}</span>
                            {d.duplicate && <span className="inline-flex items-center gap-0.5 text-amber-400"><Copy className="h-3 w-3" />dup</span>}
                            {d.auctionDate && <span className="inline-flex items-center gap-0.5"><CalendarClock className="h-3 w-3" />{d.auctionDate}</span>}
                            {foundOn(d.foundAt) && <span>found {foundOn(d.foundAt)}</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* detail drawer */}
        {sel && (
          <>
            <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setSel(null)} />
            <aside className="fixed right-0 top-0 z-50 h-screen w-[420px] max-w-[92vw] overflow-y-auto border-l border-border bg-card p-5 shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={sel.source === "auction" ? "default" : "secondary"}>{PIPELINES[sel.source].label}</Badge>
                    <Badge variant="outline">{sel.county}</Badge>
                    {sel.duplicate && <span className="inline-flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-xs font-medium text-amber-400"><Copy className="h-3 w-3" />in both</span>}
                  </div>
                  <h2 className="mt-2 text-lg font-bold leading-tight">{sel.propertyAddress || "Address pending"}</h2>
                  <p className="font-mono text-xs text-muted-foreground">{sel.caseNumber}</p>
                </div>
                <button onClick={() => setSel(null)} className="rounded p-1 hover:bg-accent"><X className="h-5 w-5" /></button>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-accent/50 p-2"><p className="text-[10px] text-muted-foreground">Owed</p><p className="text-sm font-bold">{sel.owed != null ? formatCurrency(sel.owed) : "—"}</p></div>
                <div className="rounded-lg bg-accent/50 p-2"><p className="text-[10px] text-muted-foreground">Value</p><p className="text-sm font-bold">{sel.value != null ? formatCurrency(sel.value) : "—"}</p></div>
                <div className="rounded-lg bg-primary/10 p-2"><p className="text-[10px] text-muted-foreground">Spread</p><p className="text-sm font-bold text-primary">{sel.spread != null ? formatCurrency(sel.spread) : "—"}</p></div>
              </div>

              {(sel.auctionDate || sel.skiptraceName) && (
                <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                  {sel.auctionDate && <p className="inline-flex items-center gap-1"><CalendarClock className="h-4 w-4" /> Auction {sel.auctionDate}</p>}
                  {sel.skiptraceName && <p>Owner: {sel.skiptraceName}</p>}
                </div>
              )}

              {/* quick actions */}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <a href={sel.phones ? `tel:${sel.phones.split(",")[0].replace(/[^0-9+]/g, "")}` : undefined}
                  className={cn("inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium", sel.phones ? "bg-primary text-primary-foreground" : "cursor-not-allowed bg-accent text-muted-foreground")}>
                  <Phone className="h-4 w-4" /> {sel.phones ? "Call" : "No phone"}
                </a>
                <button title="Wires to GoHighLevel (coming soon)" className="inline-flex cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-muted-foreground">
                  <MessageSquare className="h-4 w-4" /> Text (GHL)
                </button>
                <button onClick={() => toggleRoute(sel)} disabled={!sel.propertyAddress}
                  className={cn("inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
                    inRoute(sel.id) ? "bg-primary text-primary-foreground" : "bg-accent hover:bg-accent/70",
                    !sel.propertyAddress && "cursor-not-allowed opacity-50")}>
                  <Route className="h-4 w-4" /> {inRoute(sel.id) ? "In route ✓" : "Add to route"}
                </button>
                <button onClick={() => move(sel.id, "To Knock")} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium hover:bg-accent/70">
                  <DoorOpen className="h-4 w-4" /> To Knock
                </button>
              </div>

              {/* stage control */}
              <div className="mt-4">
                <label className="text-xs font-medium text-muted-foreground">Stage</label>
                <select value={sel.stage} onChange={(e) => move(sel.id, e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
                  {PIPELINES[sel.source].stages.map((s) => <option key={s} value={s}>{s}</option>)}
                  {!(PIPELINES[sel.source].stages as readonly string[]).includes(sel.stage) && <option value={sel.stage}>{sel.stage}</option>}
                </select>
              </div>

              {/* links */}
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                {sel.propertyAddress && (
                  <>
                    <a className="inline-flex items-center gap-1 text-primary hover:underline" href={mapsUrl(sel.propertyAddress)} target="_blank" rel="noreferrer"><MapPin className="h-4 w-4" /> Map</a>
                    <a className="inline-flex items-center gap-1 text-primary hover:underline" href={zillowUrl(sel.propertyAddress)} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> Zillow</a>
                  </>
                )}
                {sel.sourceUrl && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={sel.sourceUrl} target="_blank" rel="noreferrer"><FileText className="h-4 w-4" /> {sel.source === "auction" ? "Auction" : "Docket"}</a>}
              </div>

              <p className="mt-5 text-[11px] text-muted-foreground">Automations (auto-text, route, skip-trace on stage change) plug in here — coming soon.</p>
            </aside>
          </>
        )}

        {/* door-knock route builder */}
        {route.length > 0 && (
          <div className="fixed bottom-4 left-1/2 z-[60] w-[92vw] max-w-xl -translate-x-1/2 rounded-xl border border-border bg-card p-3 shadow-xl">
            <div className="flex items-center gap-2">
              <Route className="h-5 w-5 text-primary" />
              <span className="font-semibold">{route.length} stop{route.length > 1 ? "s" : ""} on route</span>
              <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="Start address (optional)"
                className="ml-auto w-44 rounded-lg border border-border bg-background px-2 py-1 text-xs" />
              <button onClick={optimizeRoute} disabled={route.length < 3 || optimizing}
                className={cn("inline-flex items-center gap-1 rounded-lg border border-primary/40 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10", (route.length < 3 || optimizing) && "cursor-not-allowed opacity-50")}
                title={route.length < 3 ? "Add 3+ stops to optimize" : "Reorder into the shortest loop"}>
                {optimizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {optimizing ? "Optimizing…" : "Optimize"}
              </button>
              <button onClick={() => setShowMap(true)} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
                <MapPin className="h-4 w-4" /> View route
              </button>
              <button onClick={() => setRoute([])} className="rounded p-1 text-muted-foreground hover:bg-accent" title="Clear route"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Reorder stops with ▲▼ to try a path — or hit <span className="font-medium text-primary">Optimize</span> for the shortest loop (set a Start address for best results).</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {route.map((r, i) => (
                <span key={r.id} className="inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-xs">
                  <span className="font-semibold text-primary">{i + 1}.</span> {r.address.split(",")[0]}
                  <button onClick={() => moveStop(i, -1)} disabled={i === 0} className={cn("text-muted-foreground hover:text-foreground", i === 0 && "opacity-30")} title="Move up"><ChevronUp className="h-3 w-3" /></button>
                  <button onClick={() => moveStop(i, 1)} disabled={i === route.length - 1} className={cn("text-muted-foreground hover:text-foreground", i === route.length - 1 && "opacity-30")} title="Move down"><ChevronDown className="h-3 w-3" /></button>
                  <button onClick={() => setRoute((prev) => prev.filter((x) => x.id !== r.id))} className="text-muted-foreground hover:text-foreground" title="Remove"><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* embedded route map — stays in-app */}
        {showMap && route.length > 0 && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={() => setShowMap(false)}>
            <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 border-b border-border p-3">
                <Route className="h-5 w-5 text-primary" />
                <span className="font-semibold">Door-knock route · {route.length} stop{route.length > 1 ? "s" : ""}</span>
                <button onClick={openInMapsApp} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium hover:bg-accent/70" title="Open in the Google Maps app for phone navigation">
                  <ExternalLink className="h-4 w-4" /> Navigate on phone
                </button>
                <button onClick={() => setShowMap(false)} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-5 w-5" /></button>
              </div>
              <iframe title="route" src={embedUrl()} className="flex-1 w-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
