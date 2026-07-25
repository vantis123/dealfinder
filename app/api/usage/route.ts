import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Usage & cost telemetry for every external service DealFinder touches.
// Each probe is independently try/caught — one dead service never blanks the tab.
export const dynamic = "force-dynamic";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key",
  { auth: { persistSession: false } }
);

const T = (ms = 8000) => ({ signal: AbortSignal.timeout(ms) });
const j = (r: Response) => r.json();

async function apifyAccount(token: string | undefined, fallbackLabel: string) {
  if (!token) return null;
  try {
    const [me, limits] = await Promise.all([
      fetch(`https://api.apify.com/v2/users/me?token=${token}`, T()).then(j),
      fetch(`https://api.apify.com/v2/users/me/limits?token=${token}`, T()).then(j),
    ]);
    const d = limits?.data;
    if (!d) return { label: fallbackLabel, ok: false, error: "no limits data" };
    return {
      label: me?.data?.username || fallbackLabel,
      email: me?.data?.email || null,
      ok: true,
      usedUsd: d.current?.monthlyUsageUsd ?? null,
      limitUsd: d.limits?.maxMonthlyUsageUsd ?? null,
      resetsAt: d.monthlyUsageCycle?.endAt || null,
      maxed: (d.current?.monthlyUsageUsd ?? 0) >= (d.limits?.maxMonthlyUsageUsd ?? Infinity),
    };
  } catch (e: any) {
    return { label: fallbackLabel, ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

async function capsolver(key: string | undefined) {
  if (!key) return null;
  try {
    const r = await fetch("https://api.capsolver.com/getBalance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key }),
      ...T(),
    }).then(j);
    return { ok: r?.errorId === 0, balanceUsd: r?.balance ?? null };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

async function telegramBot(token: string | undefined, label: string) {
  if (!token) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, T()).then(j);
    return { label, ok: !!r?.ok, username: r?.result?.username || null };
  } catch (e: any) {
    return { label, ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

async function tableStats(table: string) {
  try {
    const count = async (build: (q: any) => any) => {
      const { count: c } = await build(sb.from(table).select("*", { count: "exact", head: true }));
      return c ?? 0;
    };
    const [total, flagged, valued] = await Promise.all([
      count((q) => q),
      count((q) => q.eq("flagged", true)),
      count((q) => q.not("zillow_value", "is", null)),
    ]);
    return { ok: true, total, flagged, valued };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

export async function GET() {
  const ROOT = process.cwd();

  // Scan health — scan-status.json is written live by every scraper run.
  let scan: any = null;
  try { scan = JSON.parse(readFileSync(join(ROOT, "scan-status.json"), "utf8")); } catch {}
  let cronLog: any = null;
  try {
    const st = statSync(join(ROOT, "daily-cron.log"));
    cronLog = { sizeMb: +(st.size / 1e6).toFixed(1), modifiedAt: st.mtime.toISOString() };
  } catch {}

  // Telegram receivers (labels only — no tokens leave the server).
  let receivers: { label: string }[] = [];
  try {
    receivers = JSON.parse(process.env.TELEGRAM_RECEIVERS || "[]").map((r: any) => ({ label: r.label || String(r.chat) }));
  } catch {}

  const [apifyPrimary, apifyDyer, cap, botPrimary, notified, foreclosure, auction] = await Promise.all([
    apifyAccount(process.env.APIFY_API_TOKEN, "primary").then(a => a && { ...a, active: true }),
    apifyAccount(process.env.APIFY_API_TOKEN_DYER, "dyer").then(a => a && { ...a, active: false }),
    capsolver(process.env.CAPSOLVER_API_KEY),
    telegramBot(process.env.TELEGRAM_BOT_TOKEN, "primary"),
    (async () => {
      try {
        const { count } = await sb.from("foreclosure_leads").select("*", { count: "exact", head: true }).not("notified_at", "is", null);
        return count ?? 0;
      } catch { return null; }
    })(),
    tableStats("foreclosure_leads"),
    tableStats("auction_leads"),
  ]);

  return NextResponse.json({
    // Stripe Payment Link (env FUND_LINK) — lets anyone buy scanner credits with THEIR card,
    // no access to Phillip's vendor accounts needed. Set it in .env once created in Stripe.
    fundLink: process.env.FUND_LINK || null,
    checkedAt: new Date().toISOString(),
    apify: [apifyPrimary, apifyDyer].filter(Boolean),
    capsolver: cap,
    telegram: { bot: botPrimary, receivers, notifiedLeads: notified },
    supabase: { foreclosure_leads: foreclosure, auction_leads: auction },
    scan,
    cronLog,
    // AI extraction cost of the LAST scan run (OCR-first keeps this near $0; Claude vision is the fallback).
    ai: scan
      ? {
          lastRunCostUsd: scan.aiCostUsd ?? 0, tokensIn: scan.tokensIn ?? 0, tokensOut: scan.tokensOut ?? 0, mode: scan.mode || null,
          email: process.env.ANTHROPIC_ACCOUNT_EMAIL || null,   // shown next to the "Log in & add credits" button
        }
      : null,
  });
}
