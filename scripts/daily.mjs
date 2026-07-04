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
log(`daily scan starting for: ${ready.join(', ')} | new foreclosures ${DATE_FROM} → ${DATE_TO}`);
for (const county of ready) {
  log(`=== ${county} (${COUNTIES[county].name}) ===`);
  try {
    // DATE_FROM/DATE_TO = rolling window. COUNTY tags rows. NOTIFY_ON_SCAN=0 → one combined report below.
    execFileSync(process.execPath, [join(__dirname, SCRIPTS[county] || 'run-month.mjs')], {
      stdio: 'inherit',
      env: { ...process.env, COUNTY: county, DATE_FROM, DATE_TO, NOTIFY_ON_SCAN: '0' },
    });
  } catch (e) {
    log(`scan FAILED for ${county}:`, String(e.message).slice(0, 100));
  }
}

// Auctions (RealForeclose) — stealth-walk each auction county's calendar, value via Zillow → auction_leads.
const AUCTION_COUNTIES = (env.AUCTION_COUNTIES || 'Seminole,Orange,Volusia,Polk').split(',').map(s => s.trim()).filter(Boolean);
const AUCTION_MONTHS = env.AUCTION_MONTHS_AHEAD || '6';
for (const county of AUCTION_COUNTIES) {
  log(`=== ${county} auctions (RealForeclose) ===`);
  try {
    execFileSync(process.execPath, [join(__dirname, 'run-realforeclose.mjs')], {
      stdio: 'inherit',
      env: { ...process.env, COUNTY: county.toLowerCase(), ENGINE: 'camoufox', HEADLESS: '1', MONTHS_AHEAD: AUCTION_MONTHS },
    });
  } catch (e) { log(`auction scan FAILED for ${county}:`, String(e.message).slice(0, 100)); }
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
