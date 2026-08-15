// Daily run — the Railway Cron entry point. For each ENABLED + ready county: scrape a rolling window of
// NEW foreclosures (last DAILY_DAYS days, default 3 — dedups via upsert so weekend/missed runs self-heal),
// value via Apify, recompute spreads — then send ONE combined Telegram report of the new door-knock leads.
//
// Run: node scripts/daily.mjs
// Env: ENABLED_COUNTIES="Orange,Seminole" (default Orange); DAILY_DAYS=3 (rolling window).
//      Counties whose scraper isn't wired (scraper:'pending' in counties.mjs) are skipped with a log line.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_env.mjs';
import { notifyTelegram } from './notify-telegram.mjs';
import { COUNTIES, parseCounties, readyCounties } from './counties.mjs';
import { ensureCamoufox } from './ensure-camoufox.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const env = loadEnv(ROOT);
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// Each county runs its own scraper (Orange = myeclerk/reCAPTCHA, Seminole = ASP.NET/NoBot).
const SCRIPTS = { Orange: 'run-month.mjs', Seminole: 'run-seminole.mjs', Lake: 'run-lake.mjs', Brevard: 'run-brevard.mjs', Volusia: 'run-volusia.mjs', Osceola: 'run-osceola.mjs', Polk: 'run-polk.mjs' };

// Rolling "new foreclosures" window: last DAILY_DAYS days → today.
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAYS = parseInt(env.DAILY_DAYS || '3', 10);
const toD = new Date(); const fromD = new Date(); fromD.setDate(fromD.getDate() - DAYS);
const DATE_FROM = iso(fromD), DATE_TO = iso(toD);

const requested = parseCounties(env.ENABLED_COUNTIES);
const ready = readyCounties(requested);
const skipped = requested.filter(c => !ready.includes(c));
if (skipped.length) log(`skipping (scraper pending): ${skipped.join(', ')}`);
if (!ready.length) { log('no ready counties to scan — set ENABLED_COUNTIES'); process.exit(0); }

const runStart = new Date().toISOString();
// Ensure the stealth browser is installed before any county runs (installs once, persists on the volume).
try { log(`camoufox: ${await ensureCamoufox()}`); } catch (e) { log('camoufox ensure FAILED:', String(e.message).slice(0, 120)); }
log(`daily scan starting for: ${ready.join(', ')} | new foreclosures ${DATE_FROM} → ${DATE_TO}`);
for (const county of ready) {
  log(`=== ${county} (${COUNTIES[county].name}) ===`);
  try {
    // DATE_FROM/DATE_TO = rolling window. COUNTY tags rows. NOTIFY_ON_SCAN=0 → one combined report below.
    // hard timeout: a wedged browser once held run-month.mjs at 0/0 for 7.5h (2026-07-14) and the
    // whole pipeline (auctions, Telegram report) never ran — kill and move to the next county instead.
    execFileSync(process.execPath, [join(__dirname, SCRIPTS[county] || 'run-month.mjs')], {
      stdio: 'inherit',
      timeout: parseInt(env.CLERK_TIMEOUT_MIN || '150', 10) * 60_000, killSignal: 'SIGKILL',
      // USE_AI default was '0' from 2026-07-14 to 2026-08-11 (a $5-15/mo cost cut). It removed the
      // Claude tiers from addr()/owed(), and because the address path had NO OCR at all, scanned
      // complaints lost their only reader: non-Orange address loss went 56% -> 96% and ~70% of
      // pre-foreclosure leads were dropped before reaching the CRM for four weeks.
      // Restored to '1' 2026-08-11. The AI tiers are now a LAST resort, not the primary path —
      // scripts/_extract.mjs does pdftotext -> free on-box OCR -> deterministic label-aware pick
      // first, so this flag should rarely cost anything. Set USE_AI=0 in .env to force free-only.
      env: { ...process.env, COUNTY: county, DATE_FROM, DATE_TO, NOTIFY_ON_SCAN: '0', USE_AI: env.USE_AI || '1' },
    });
  } catch (e) {
    log(`scan FAILED for ${county}:`, e.code === 'ETIMEDOUT' ? `TIMED OUT after ${env.CLERK_TIMEOUT_MIN || 150} min (killed)` : String(e.message).slice(0, 100));
  }
}

// Auctions (RealForeclose) — stealth-walk each auction county's calendar, value via Zillow → auction_leads.
// CADENCE (Phillip, 2026-07-14): TUESDAYS ONLY, and only the NEXT WEEK of auction dates — running
// this DAILY across 4 counties × 6 months got the home IP 403-banned by RealAuction's WAF on 07-12.
// AUCTION_DAYS = comma-separated JS weekdays (0=Sun … 6=Sat). Default "2" = Tuesday.
// AUCTION_DAYS_AHEAD limits how far ahead run-realforeclose scans (default 7 days).
const AUCTION_COUNTIES = (env.AUCTION_COUNTIES || 'Seminole,Orange,Volusia,Polk').split(',').map(s => s.trim()).filter(Boolean);
const AUCTION_MONTHS = env.AUCTION_MONTHS_AHEAD || '2';   // calendar pages to walk (a 7-day window can straddle a month boundary)
const AUCTION_AHEAD = env.AUCTION_DAYS_AHEAD || '7';
const auctionDays = (env.AUCTION_DAYS || '2').split(',').map(Number);
if (!auctionDays.includes(new Date().getDay())) {
  log(`auctions: skipped today (runs on weekday(s) ${auctionDays.join(',')} — set AUCTION_DAYS to change)`);
} else for (const county of AUCTION_COUNTIES) {
  log(`=== ${county} auctions (RealForeclose) ===`);
  try {
    execFileSync(process.execPath, [join(__dirname, 'run-realforeclose.mjs')], {
      stdio: 'inherit',
      timeout: parseInt(env.AUCTION_TIMEOUT_MIN || '120', 10) * 60_000, killSignal: 'SIGKILL',
      env: { ...process.env, COUNTY: county.toLowerCase(), ENGINE: 'camoufox', HEADLESS: '1', MONTHS_AHEAD: AUCTION_MONTHS, DAYS_AHEAD: AUCTION_AHEAD },
    });
  } catch (e) { log(`auction scan FAILED for ${county}:`, e.code === 'ETIMEDOUT' ? `TIMED OUT after ${env.AUCTION_TIMEOUT_MIN || 120} min (killed)` : String(e.message).slice(0, 100)); }
}

// Combined daily summary across all counties → scan-status.json (drives the dashboard "daily update" popup).
try {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data } = await sb.from('foreclosure_leads').select('flagged,review_status,spread').gte('updated_at', runStart);
  let knock = 0, review = 0, notWorth = 0, pipeline = 0;
  for (const r of data || []) { if (r.flagged) { knock++; pipeline += Number(r.spread) || 0; } else if (r.review_status === 'manual_review') review++; else notWorth++; }
  const total = (data || []).length;
  writeFileSync(join(ROOT, 'scan-status.json'), JSON.stringify({
    running: false, county: ready.join(' + '), from: DATE_FROM, to: DATE_TO,
    total, done: total, knock, review, notWorth, pipelineAdded: pipeline, daily: true, finishedAt: new Date().toISOString(),
  }, null, 2));
  log(`combined daily summary: ${knock} knock · ${review} review · ${notWorth} not-worth · $${Math.round(pipeline)} pipeline`);
} catch (e) { log('combined summary failed:', String(e.message).slice(0, 80)); }

// ── NO COUNTY-APPRAISER VALUATION. ZILLOW ONLY. ────────────────────────────────────────────────
// Phillip, 2026-08-12: "we dont want to use the county apprasial records those numbers are much
// less than market value thats why we need to rely on zillow only."
//
// `scripts/value-ocpa.mjs` was briefly wired in here earlier today and has been REMOVED. The script
// is kept in the repo (it is a working, documented appraiser client and useful for parcel/ownership
// lookups) but it must NOT write values into the valuation path. Measured bias: median
// OCPA/Zillow 0.854, range 0.52-1.00 — an assessed value is not a resale comp, and a spread built
// on one understates the deal.
//
// CONSEQUENCE, stated plainly so it is not a surprise: Zillow-only makes **Apify a single point of
// failure** for every valuation. It has capped twice (2026-07-14 and 2026-07-26), and each time the
// pipeline produced leads with no value, therefore no spread, therefore zero flagged door-knocks.
// Keeping the Apify account funded IS the valuation strategy now.
// See arvantis-brain/products/deal-finder/valuation-zillow-only.md
//
// Auto-populate the CRM — refresh the unified `deals` spine (what the CRM reads) from both source tables.
// (Phillip chose auto-flow: finds go all the way into the pipeline. Set AUTO_PROMOTE_CRM=0 to disable.)
if (env.AUTO_PROMOTE_CRM !== '0') {
  log('=== normalize → deals spine ===');
  try { execFileSync(process.execPath, [join(__dirname, 'normalize-deals.mjs')], { stdio: 'inherit', env: process.env }); }
  catch (e) { log('normalize failed:', String(e.message).slice(0, 100)); }
}

log('=== daily Telegram report (by county) ===');
try { log('telegram:', JSON.stringify(await notifyTelegram())); }
catch (e) { log('telegram failed:', String(e.message).slice(0, 100)); }

log('daily run complete');
process.exit(0);
