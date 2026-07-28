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

// Failures collected across the whole run (per-county + top-level) so a bad run is VISIBLE on the
// dashboard's "Scan health" tile instead of silently vanishing into the log file (2026-07-27 fix).
const errors = [];
const recordError = (stage, county, e) => errors.push({ stage, county: county || null, message: String(e?.message || e).slice(0, 160) });

// Top-level crash guard: if anything below throws uncaught, still write a status so the dashboard
// shows CRASHED instead of quietly serving yesterday's stale scan-status.json as "current".
process.on('unhandledRejection', (e) => { recordError('unhandled-rejection', null, e); crashAndExit(e); });
function crashAndExit(e) {
  try {
    writeFileSync(join(ROOT, 'scan-status.json'), JSON.stringify({
      running: false, ok: false, errors, crashedAt: new Date().toISOString(), error: String(e?.message || e).slice(0, 200),
    }, null, 2));
  } catch {}
  log('daily run CRASHED:', String(e?.message || e).slice(0, 200));
  process.exit(1);
}

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

// Whole run wrapped in try/finally so a hard, uncaught crash ANYWHERE below still leaves a fresh
// scan-status.json behind (ok:false + crashedAt) instead of the dashboard silently showing stale
// data from the previous successful run. `ranOk` tracks whether we reached the end cleanly.
let ranOk = false;
try {
  // Ensure the stealth browser is installed before any county runs (installs once, persists on the volume).
  try { log(`camoufox: ${await ensureCamoufox()}`); } catch (e) { log('camoufox ensure FAILED:', String(e.message).slice(0, 120)); recordError('camoufox-ensure', null, e); }
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
        // USE_AI=0 (Phillip 2026-07-14): OCR/regex-only everywhere, like Orange — the non-Orange county
        // scripts default Claude vision ON, which was the biggest controllable API line ($5-15/mo).
        // Scanned-image PDFs land in manual_review instead. Set USE_AI=1 in .env to re-enable.
        env: { ...process.env, COUNTY: county, DATE_FROM, DATE_TO, NOTIFY_ON_SCAN: '0', USE_AI: env.USE_AI || '0' },
      });
    } catch (e) {
      log(`scan FAILED for ${county}:`, e.code === 'ETIMEDOUT' ? `TIMED OUT after ${env.CLERK_TIMEOUT_MIN || 150} min (killed)` : String(e.message).slice(0, 100));
      recordError('clerk-scan', county, e);
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
    } catch (e) {
      log(`auction scan FAILED for ${county}:`, e.code === 'ETIMEDOUT' ? `TIMED OUT after ${env.AUCTION_TIMEOUT_MIN || 120} min (killed)` : String(e.message).slice(0, 100));
      recordError('auction-scan', county, e);
    }
  }

  // Appraiser fallback — fills in anything Zillow couldn't value. Free, no cap, no bot wall,
  // so it runs every day regardless of Apify state. It only touches leads with zillow_value
  // IS NULL and writes value_source='ocpa', so a real Zillow comp is never overwritten.
  // The number it produces is a FLOOR (~15% under Zillow, measured) — good enough to CONFIRM
  // a door-knock, never used to reject one. See scripts/value-ocpa.mjs for the full rationale.
  try {
    log('=== appraiser valuation fallback (free) ===');
    execFileSync(process.execPath, [join(__dirname, 'value-ocpa.mjs')], { stdio: 'inherit', timeout: 20 * 60_000, killSignal: 'SIGKILL', env: process.env });
  } catch (e) { log('ocpa valuation failed:', String(e.message).slice(0, 100)); recordError('ocpa-valuation', null, e); }

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
      ok: errors.length === 0, errors,
    }, null, 2));
    log(`combined daily summary: ${knock} knock · ${review} review · ${notWorth} not-worth · $${Math.round(pipeline)} pipeline`);
  } catch (e) { log('combined summary failed:', String(e.message).slice(0, 80)); recordError('combined-summary', null, e); }

  // Auto-populate the CRM — refresh the unified `deals` spine (what the CRM reads) from both source tables.
  // (Phillip chose auto-flow: finds go all the way into the pipeline. Set AUTO_PROMOTE_CRM=0 to disable.)
  if (env.AUTO_PROMOTE_CRM !== '0') {
    log('=== normalize → deals spine ===');
    try { execFileSync(process.execPath, [join(__dirname, 'normalize-deals.mjs')], { stdio: 'inherit', env: process.env }); }
    catch (e) { log('normalize failed:', String(e.message).slice(0, 100)); recordError('normalize-deals', null, e); }
  }

  log('=== daily Telegram report (by county) ===');
  try { log('telegram:', JSON.stringify(await notifyTelegram())); }
  catch (e) { log('telegram failed:', String(e.message).slice(0, 100)); recordError('telegram', null, e); }

  ranOk = true;
} catch (e) {
  // Anything that escaped every inner try/catch above (a genuine hard crash) lands here.
  recordError('top-level', null, e);
  crashAndExit(e);
} finally {
  if (ranOk) log('daily run complete');
}

process.exit(0);
