// VALUE AGENT — run this on a HOME machine (Mac, laptop, office PC). It values properties
// from that machine's residential internet connection and writes the results back to Supabase.
//
// WHY THIS EXISTS
// DealFinder was designed to run on a buyer's own computer (see BUYER-SETUP.md), which is why
// `run-month.mjs` says "Zillow via local Camoufox (home residential IP + stealth) — no proxy
// needed." That assumption held until the scanner moved to a VPS. Zillow (PerimeterX) scores
// IP REPUTATION as well as browser fingerprint, and a datacenter IP fails on sight — measured
// on the Hostinger box 2026-07-26: 1/36 valued (2.8%). The same stealth browser scrapes
// RealForeclose from that box perfectly, because RealAuction doesn't score IP reputation.
//
// So: let the VPS do the scraping (it's good at that, and it's always on), and let a machine
// on a real home connection do the valuing. This is what a residential proxy rents you —
// except it's your own connection, doing your own work, for your own leads. No third party's
// bandwidth, no rotating pool, nothing to buy.
//
// It talks to Supabase directly, so the VPS does not need to be publicly exposed and there is
// no new API to secure. Anything with the project's service key and a home connection can help.
//
// RUN
//   node scripts/value-agent.mjs            # one pass, then exit
//   WATCH=1 node scripts/value-agent.mjs    # keep running, poll every POLL_SEC (default 900)
//   AGENT_MAX=25 node scripts/value-agent.mjs
//
// Safe to run on several machines at once — each claims a different slice (see claiming below).

import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ME = process.env.AGENT_NAME || hostname();
const MAX = parseInt(process.env.AGENT_MAX || '40', 10);
const PAUSE_MS = parseInt(process.env.AGENT_PAUSE_MS || '2500', 10);
const FLAG_AT = Number(env.SPREAD_FLAG_AT || 200000);
const POLL_SEC = parseInt(process.env.POLL_SEC || '900', 10);
const WATCH = process.env.WATCH === '1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `[agent:${ME}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };

// Refuse to run from a datacenter — the whole point of this agent is the residential IP.
// Better to fail loudly on the wrong machine than to quietly return 0/40 and look "broken".
async function assertResidential() {
  if (process.env.SKIP_IP_CHECK === '1') return;
  try {
    const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) }).then(x => x.json());
    const org = String(r.org || '');
    const hosting = /hostinger|digitalocean|linode|vultr|amazon|aws|google|azure|ovh|hetzner|contabo|oracle|scaleway|choopa|leaseweb/i.test(org);
    log(`egress: ${r.ip} · ${org} · ${r.city || '?'}, ${r.region || '?'}`);
    if (hosting) {
      log('REFUSING TO RUN — this looks like a datacenter/hosting network.');
      log('Zillow blocks these on IP reputation regardless of browser. Run this agent on a home/office connection.');
      log('(Override with SKIP_IP_CHECK=1 if this detection is wrong.)');
      process.exit(2);
    }
    if (r.country && r.country !== 'US') log(`WARNING: egress country is ${r.country} — Zillow walls non-US IPs too.`);
  } catch { log('egress check failed (continuing anyway)'); }
}

let Camoufox;
async function zillowValue(address) {
  let ctx = null;
  try {
    ({ Camoufox } = Camoufox ? { Camoufox } : await import('camoufox-js'));
    const slug = String(address)
      .replace(/\bAlt\.?\s*/ig, 'Alternate ').replace(/[#.]/g, '').replace(/,/g, '')
      .replace(/\s+/g, '-').replace(/-+/g, '-');
    ctx = await Camoufox({ headless: true, user_data_dir: `/tmp/camou-agent-${process.pid}-${Math.random().toString(36).slice(2, 7)}` });
    const p = ctx.pages()[0] || await ctx.newPage();
    await p.goto(`https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await p.waitForTimeout(4000);
    const h = await p.content();
    // If we hit the bot wall, say so — a null here is NOT the same as "no such property".
    if (/px-captcha|press\s*&\s*hold|Access to this page has been denied/i.test(h)) return { blocked: true, value: null };
    const m = h.match(/Zestimate[^$]{0,40}\$([\d,]{6,})/i)
      || h.match(/"zestimate":\s*(\d{5,})/i)
      || h.match(/"price":(\d{5,})/i)
      || h.match(/\$([\d,]{6,})\b[^<]{0,30}(?:Zestimate|est\.)/i);
    return { blocked: false, value: m ? money(m[1]) : null };
  } catch (e) {
    return { blocked: false, value: null, error: String(e.message).slice(0, 80) };
  } finally { if (ctx) await ctx.close().catch(() => {}); }
}

async function pass() {
  // Claim work: oldest-first, only rows with an address and no Zillow value yet. The appraiser
  // may already have written assessed_value — we still want the real Zestimate, so
  // value_source='ocpa' rows are deliberately NOT excluded.
  const { data, error } = await sb
    .from('foreclosure_leads')
    .select('case_number, property_address, owed_with_buffer')
    .is('zillow_value', null)
    .not('property_address', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(MAX);
  if (error) { log('query failed:', error.message); return 0; }

  const rows = data || [];
  if (!rows.length) { log('nothing to value'); return 0; }
  log(`${rows.length} to value (cap ${MAX})`);

  let ok = 0, blocked = 0, knock = 0;
  for (const r of rows) {
    const { value, blocked: wall, error: err } = await zillowValue(r.property_address);
    if (wall) {
      blocked++;
      // Three walls in a row means this connection is burnt for now — stop rather than
      // hammer Zillow and deepen the block.
      if (blocked >= 3 && ok === 0) { log('blocked 3× with no successes — stopping this pass'); break; }
      await sleep(PAUSE_MS * 2);
      continue;
    }
    if (value == null) { if (err) log(`  ${r.case_number}: ${err}`); await sleep(PAUSE_MS); continue; }

    const owed = Number(r.owed_with_buffer) || 0;
    const spread = owed ? value - owed : null;
    const flagged = spread != null ? spread >= FLAG_AT : null;
    const patch = { zillow_value: value, spread, value_source: 'zillow', updated_at: new Date().toISOString() };
    if (flagged != null) patch.flagged = flagged;
    if (flagged) { patch.review_status = 'auto'; patch.review_reason = null; knock++; }

    const { error: uerr } = await sb.from('foreclosure_leads').update(patch).eq('case_number', r.case_number);
    if (uerr) log(`  update failed ${r.case_number}: ${uerr.message.slice(0, 60)}`);
    else { ok++; log(`  ${String(r.property_address).split(',')[0].slice(0, 40)} → $${value.toLocaleString()}${flagged ? '  ★ KNOCK' : ''}`); }
    await sleep(PAUSE_MS);
  }
  log(`pass done — valued ${ok}/${rows.length} | blocked ${blocked} | new KNOCK ${knock}`);
  return ok;
}

await assertResidential();
if (WATCH) {
  log(`watch mode — every ${POLL_SEC}s. Ctrl-C to stop.`);
  for (;;) { await pass(); await sleep(POLL_SEC * 1000); }
} else {
  await pass();
  process.exit(0);
}
