// Batch skip-trace — runs LOCALLY (not on Railway yet). For each lead not yet phoned, look up the
// owner's phone numbers (TruePeopleSearch + FastPeopleSearch, free sites via Camoufox stealth — no
// paid API, no CapSolver) and store them on the lead. Reuses one browser session across leads.
// Idempotent + resumable: skips any lead that already has a phone (checked in-memory below, not just
// skip_traced_at, so a lead that was attempted-but-came-up-empty gets retried on the next run).
//
// Sources:
//   preforeclosure (foreclosure_leads) — has an owner name (`defendant`, from the court complaint).
//   auction        (auction_leads)     — NO owner-name column exists in this pipeline yet (clerk-enrich
//                                        only pulls sale date / value sheet / notice of sale for auctions,
//                                        never an owner). Traced address-only: skiptrace.mjs falls back
//                                        to the first person-search result at that address when there's
//                                        no name to confirm an "exact" match — lower-confidence than a
//                                        name-matched preforeclosure trace. Flag this to a human before
//                                        pushing auction-sourced phones into an SMS funnel.
//
// CLI:
//   node scripts/skiptrace-run.mjs [--source=preforeclosure|auction|all] [--limit N] [--county Orange]
//                                   [--flagged-only] [--all] [--headed]
//   --source        which source table(s) to trace (default: all)
//   --limit N       cap total leads traced this run (applied per source, in priority order)
//   --county X      only trace leads in this county (case-insensitive)
//   --flagged-only  restore the original door-knock-only behavior (flagged=true leads only)
//   --all           re-trace leads that already have a skip_traced_at timestamp but still show no phone
//                   (does NOT re-trace leads that already have a phone — that's never re-run)
//   --headed        show the browser (debugging)
import { createClient } from '@supabase/supabase-js';
import { Camoufox } from 'camoufox-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from './_env.mjs';
import { traceWithPage, parseAddress } from './skiptrace.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// Supports both `--flag value` and `--flag=value` forms.
const arg = k => {
  const eq = process.argv.find(a => a.startsWith(`--${k}=`));
  if (eq) return eq.slice(k.length + 3);
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : null;
};

const SOURCE = arg('source') || 'all';
const LIMIT = parseInt(arg('limit') || '0', 10);
const COUNTY = arg('county');
const FLAGGED_ONLY = process.argv.includes('--flagged-only');
const REDO_EMPTY = process.argv.includes('--all'); // re-attempt leads previously traced with no phone found
const HEADED = process.argv.includes('--headed');

const hasPhone = phones => Array.isArray(phones) ? phones.length > 0 : !!(phones && phones !== '[]');

// Per-source config: table, select columns, the "owner name" field (null if the table has none),
// and the write-back shape.
const SOURCES = {
  preforeclosure: {
    table: 'foreclosure_leads',
    idCol: 'case_number',
    nameCol: 'defendant',
    select: 'case_number,defendant,property_address,county,spread,phones,skip_traced_at',
  },
  auction: {
    table: 'auction_leads',
    idCol: 'case_number',
    nameCol: null, // no owner-name column in this pipeline (see header note)
    select: 'case_number,property_address,county,spread,phones,skip_traced_at',
  },
};

// address-only leads (auction, no owner name) need a city/state/zip to search TruePeopleSearch/
// FastPeopleSearch by address — a bare street ("1370 PORTMOOR WAY") can't be searched. Some counties'
// auction scraper (run-realforeclose.mjs) captures the full "street, city, FL zip" line, others
// (currently Orange) only capture the street. Filter those out here rather than burn a cycle marking
// them "traced, no phone" when they were never actually searchable.
let noAddrSkipped = 0;
function hasSearchableAddress(addr) {
  const { street, csz } = parseAddress(addr);
  return !!(street && csz);
}

async function fetchCandidates(key) {
  const cfg = SOURCES[key];
  let q = sb.from(cfg.table).select(cfg.select).not('property_address', 'is', null);
  if (FLAGGED_ONLY) q = q.eq('flagged', true);
  if (COUNTY) q = q.ilike('county', COUNTY);
  if (cfg.nameCol) q = q.not(cfg.nameCol, 'is', null);
  q = q.order('spread', { ascending: false, nullsFirst: false }).limit(2000);
  const { data, error } = await q;
  if (error) throw new Error(`${cfg.table} query failed: ${error.message}`);
  return (data || []).filter(r => {
    if (hasPhone(r.phones)) return false; // hard rule: never re-trace a lead that already has a phone
    if (!REDO_EMPTY && r.skip_traced_at) return false; // already attempted this run-cycle, came up empty
    if (!hasSearchableAddress(r.property_address)) { noAddrSkipped++; return false; }
    return true;
  }).map(r => ({ ...r, __source: key }));
}

const keys = SOURCE === 'all' ? Object.keys(SOURCES) : [SOURCE];
if (!keys.every(k => SOURCES[k])) { console.log(`unknown --source "${SOURCE}" (use preforeclosure|auction|all)`); process.exit(1); }

let leads = [];
for (const k of keys) leads = leads.concat(await fetchCandidates(k));
if (LIMIT) leads = leads.slice(0, LIMIT);

if (noAddrSkipped) log(`skipped ${noAddrSkipped} lead(s) with no city/state/zip in property_address (not searchable — scraper-level gap, not a trace failure)`);
if (!leads.length) { log('no leads need skip-tracing (all remaining already have a phone, or none match the filters — use --all to retry empty prior attempts)'); process.exit(0); }

log(`skip-tracing ${leads.length} lead(s) across [${keys.join(', ')}]${FLAGGED_ONLY ? ' (flagged-only)' : ''}${COUNTY ? ` in ${COUNTY}` : ''}…`);
const ctx = await Camoufox({ headless: !HEADED, user_data_dir: join(tmpdir(), `camou-skiprun-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
let hit = 0;
const runStart = Date.now();
const timings = [];
try {
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    const cfg = SOURCES[l.__source];
    const ownerName = cfg.nameCol ? l[cfg.nameCol] : ''; // auction: no name → address-only trace
    const t0 = Date.now();
    let r;
    try { r = await traceWithPage(p, ownerName, l.property_address); }
    catch (e) { r = { matched: null, phones: [] }; log(`  [${l.__source}] ${l.case_number} error:`, String(e.message).slice(0, 50)); }
    const ms = Date.now() - t0;
    timings.push(ms);
    const { error: writeErr } = await sb.from(cfg.table).update({
      phones: r.phones || [], skiptrace_name: r.matched || null, skip_traced_at: new Date().toISOString(),
    }).eq(cfg.idCol, l[cfg.idCol]);
    if (writeErr) log(`  [${l.__source}] ${l.case_number} WRITE FAILED:`, writeErr.message);
    if (r.phones?.length) hit++;
    log(`  ${i + 1}/${leads.length} [${l.__source}] ${l.case_number} | ${ownerName || '(no name — address-only)'} → ${r.matched || 'no match'} | ${(r.phones || []).map(x => x.phone).join(', ') || 'no phones'} | ${ms}ms`);
  }
} finally { await ctx.close().catch(() => {}); }

const totalMs = Date.now() - runStart;
const avgMs = Math.round(timings.reduce((a, b) => a + b, 0) / (timings.length || 1));
log(`done — ${hit}/${leads.length} leads got phone numbers | total ${(totalMs / 1000).toFixed(1)}s | avg ${(avgMs / 1000).toFixed(1)}s/lead | no paid API cost (free-site scrape via Camoufox)`);
process.exit(0);
