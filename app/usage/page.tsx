"use client";

import { useEffect, useState, useCallback } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Gauge, RefreshCw, Loader2, Database, Bot, Send, Activity, CircleDollarSign, ExternalLink } from "lucide-react";

// Usage tab — one place to see how much of every service DealFinder is burning, with a
// one-click REFILL link on every card that can run dry. Low balances also get pushed into
// the daily Telegram report automatically (see scripts/notify-telegram.mjs).

const money = (n: number | null | undefined, digits = 2) => (n == null ? "?" : `$${Number(n).toFixed(digits)}`);
const dateShort = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

// Where to actually refill each service (opens the vendor's login → billing page).
const REFILL = {
  apify: "https://console.apify.com/billing",
  capsolver: "https://dashboard.capsolver.com/dashboard/overview",
  anthropic: "https://console.anthropic.com/settings/billing",
};

function Dot({ ok }: { ok: boolean | null | undefined }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", ok == null ? "bg-muted-foreground/40" : ok ? "bg-emerald-500" : "bg-red-500")} />;
}

function Bar({ used, limit }: { used: number | null; limit: number | null }) {
  const pct = used != null && limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent">
      <div className={cn("h-full rounded-full transition-all", pct >= 95 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-emerald-500")}
        style={{ width: `${pct}%` }} />
    </div>
  );
}

function RefillBtn({ href, urgent, label = "Refill" }: { href: string; urgent?: boolean; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className={cn("flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-bold transition-colors",
        urgent ? "border-red-500/50 bg-red-500/10 text-red-500 hover:bg-red-500/20"
               : "border-border text-muted-foreground hover:bg-accent hover:text-foreground")}>
      {label} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

// The login email, one tap to copy — vendor login pages can't be pre-filled from outside,
// so this is the fastest honest path: copy the account email, click Log in & refill, paste.
function CopyEmail({ email }: { email: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!email) return null;
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(email); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      title={`Copy login email: ${email}`}
      className="max-w-full truncate rounded bg-accent px-1.5 py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
      {copied ? "✓ copied" : email}
    </button>
  );
}

function SectionCard({ icon: Icon, title, action, children }: { icon: any; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="min-w-0 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="truncate text-sm font-bold">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

export default function UsagePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/usage");
      if (r.ok) setData(await r.json());
    } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const capLow = (data?.capsolver?.balanceUsd ?? 99) < 2;

  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="p-4 pt-16 lg:ml-64 lg:p-6 lg:pt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-extrabold lg:text-2xl"><Gauge className="h-5 w-5 text-primary" /> Usage</h1>
            <p className="truncate text-xs text-muted-foreground lg:text-sm">
              What every service is burning{data?.checkedAt ? ` · checked ${ago(data.checkedAt)}` : ""} · low balances also alert in the daily Telegram
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data?.fundLink && (
              <a href={data.fundLink} target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:opacity-90 lg:text-sm">
                💳 Buy credits
              </a>
            )}
            <button onClick={load} disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50 lg:text-sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking every service…</div>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Couldn&apos;t load usage — is the dev server running with the .env loaded?</p>
        ) : (
          <>
          {/* Scan health — full-width band across the top */}
          <Card className="mb-3 border-primary/25 bg-primary/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 shrink-0 text-primary" />
                <h2 className="text-sm font-bold">Scan health</h2>
                {data.scan ? (
                  <span className="flex items-center gap-1.5 rounded-full bg-background/60 px-2 py-0.5 text-xs font-semibold">
                    <Dot ok={!data.scan.running || undefined} /> {data.scan.running ? "RUNNING" : "idle"}
                    <span className="text-muted-foreground">· {data.scan.county}</span>
                  </span>
                ) : <span className="text-xs text-muted-foreground">No scan yet.</span>}
              </div>
              {data.scan && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs lg:text-sm">
                  <span><b className="text-foreground">{data.scan.done ?? "?"}/{data.scan.total ?? "?"}</b> <span className="text-muted-foreground">cases</span></span>
                  <span><b className="text-emerald-400">{data.scan.knock ?? 0}</b> <span className="text-muted-foreground">knock</span></span>
                  <span><b className="text-amber-400">{data.scan.review ?? 0}</b> <span className="text-muted-foreground">review</span></span>
                  {data.scan.finishedAt && <span className="text-muted-foreground">last run {ago(data.scan.finishedAt)}</span>}
                  {data.cronLog && <span className="text-muted-foreground">log {data.cronLog.sizeMb} MB · {ago(data.cronLog.modifiedAt)}</span>}
                </div>
              )}
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">

            {/* Apify — one card per subscription. The ACTIVE one is what scans burn; "Use this
                account" switches the .env token so the next run bills the other subscription. */}
            {(data.apify || []).map((a: any) => (
              <SectionCard key={a.label} icon={CircleDollarSign}
                title={`Apify — ${a.label}`}
                action={<RefillBtn href={REFILL.apify} urgent={a.maxed} label="Log in & refill" />}>
                {a.ok ? (
                  <div className="space-y-1.5 text-xs lg:text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Dot ok={!a.maxed} />
                        {a.active && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">ACTIVE</span>}
                        <span className="truncate">{a.maxed ? "MAXED OUT" : a.active ? "used by scans" : "standby"}</span>
                      </span>
                      <span className="shrink-0 font-bold">{money(a.usedUsd)} / {money(a.limitUsd, 0)}</span>
                    </div>
                    <Bar used={a.usedUsd} limit={a.limitUsd} />
                    <div className="flex items-center justify-between gap-2">
                      <CopyEmail email={a.email} />
                      {!a.active && (
                        <button onClick={async () => { const r = await fetch("/api/usage/switch", { method: "POST" }); if (r.ok) load(); else alert((await r.json()).error); }}
                          className="shrink-0 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] font-bold text-primary hover:bg-primary/20">
                          Use this account
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">resets {dateShort(a.resetsAt)}{a.maxed && " · runs refused until reset"}</p>
                  </div>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Dot ok={false} /> <span className="truncate">{a.error || "unreachable — paste this account's token in .env"}</span></p>
                )}
              </SectionCard>
            ))}

            {/* CapSolver — refill = CapSolver dashboard recharge */}
            <SectionCard icon={Bot} title="CapSolver (captchas)"
              action={<RefillBtn href={REFILL.capsolver} urgent={capLow} />}>
              {data.capsolver?.ok ? (
                <div className="space-y-1 text-xs lg:text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5"><Dot ok={!capLow} /> balance</span>
                    <span className="font-bold">{money(data.capsolver.balanceUsd)}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    ~$1 per 1,000 solves · Orange clerk + Polk only{capLow && " · LOW — refill now"}
                  </p>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Dot ok={false} /> {data.capsolver?.error || "no key / unreachable"}</p>
              )}
            </SectionCard>

            {/* Supabase */}
            <SectionCard icon={Database} title="Supabase (lead tables)">
              <div className="space-y-1.5 text-xs lg:text-sm">
                {(["foreclosure_leads", "auction_leads"] as const).map((t) => {
                  const s = data.supabase?.[t];
                  return (
                    <div key={t} className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5"><Dot ok={s?.ok} /> <span className="truncate">{t.replace("_", " ")}</span></span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {s?.ok ? <>{s.total} · <b className="text-foreground">{s.flagged} knock</b> · {s.valued} valued</> : s?.error || "?"}
                      </span>
                    </div>
                  );
                })}
                <p className="text-[11px] text-muted-foreground">Free tier (500 MB) — lead rows are tiny</p>
              </div>
            </SectionCard>

            {/* Telegram */}
            <SectionCard icon={Send} title="Telegram reports">
              <div className="space-y-1.5 text-xs lg:text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5"><Dot ok={data.telegram?.bot?.ok} /> <span className="truncate">@{data.telegram?.bot?.username || "?"}</span></span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">primary</span>
                </div>
                {(data.telegram?.receivers || []).map((r: any) => (
                  <div key={r.label} className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5"><Dot ok={true} /> <span className="truncate">{r.label}</span></span>
                    <span className="shrink-0 text-right text-[11px] text-muted-foreground">
                      {r.counties && r.counties.length ? r.counties.join(", ") : "all counties"}
                    </span>
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground">Watching by county · {data.telegram?.notifiedLeads ?? "?"} leads reported all-time · free</p>
              </div>
            </SectionCard>

          </div>
          </>
        )}
      </main>
    </div>
  );
}
