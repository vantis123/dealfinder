// HEALTH CHECK — the thing that tells Phillip when DealFinder is quietly broken.
//
// WHY IT EXISTS
// Every outage in this product's history looked like silence, not an error:
//   2026-07-12  RealAuction geo-blocked the Mac → scrapers logged "0 listing(s)" for THREE DAYS
//               and it read as three quiet days in the market.
//   2026-07-14  Apify hit its $5 cap → valuations stopped; discovered by accident.
//   2026-07-26  A 149-case scan extracted 0 addresses from 100 consecutive cases and printed DONE.
// The lesson from that incident writeup: "Silent-zero parsing is the enemy. Every scraper needs
// (a) block detection that FAILS LOUD, (b) result-shaped sanity checks, (c) hard timeouts."
// This is (a) and (b), for the whole pipeline instead of one scraper.
//
// It only messages when something is WRONG. A healthy run says nothing — an alert channel that
// pings daily gets muted, and a muted channel is the same as no channel.
//
// Run:  node scripts/healthcheck.mjs            # alert only if unhealthy
//       ALWAYS=1 node scripts/healthcheck.mjs   # always report (for testing)
//       DRY=1 node scripts/healthcheck.mjs      # print, don't send

import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[health]', ...a);

const problems = [];   // things that are broken NOW
const warnings = [];   // things that will break soon
const fail = (area, msg) => problems.push(`❌ *${area}* — ${msg}`);
const warn = (area, msg) => warnings.push(`⚠️ *${area}* — ${msg}`);

const sh = (cmd, args, timeout = 60000) => new Promise(r =>
  execFile(cmd, args, { timeout, maxBuffer: 4e6 }, (e, so, se) =>
    r({ ok: !e, out: String(so || ''), err: String(se || e?.message || '') })));

// ── 1. Apify: every account in the rotation ────────────────────────────────────
// A capped account is not an error until ALL of them are capped — that's the whole point of
// staggered free tiers. But a token that has gone INVALID is always worth knowing about.
const apifyTokens = [
  ['primary', env.APIFY_API_TOKEN],
  ...Array.from({ length: 8 }, (_, i) => [`acct${i + 2}`, env[`APIFY_API_TOKEN_${i + 2}`]]),
  ['dyer', env.APIFY_API_TOKEN_DYER],
].map(([l, t]) => [l, String(t || '').replace(/#.*/, '').trim()])
 .filter(([, t]) => t.startsWith('apify_api_'));

let apifyUsable = 0;
for (const [label, token] of apifyTokens) {
  try {
    const d = await fetch(`https://api.apify.com/v2/users/me/limits?token=${token}`, { signal: AbortSignal.timeout(20000) }).then(r => r.json());
    if (d.error) { fail('Apify', `token \`${label}\` is INVALID or revoked — replace it`); continue; }
    const used = d.data?.current?.monthlyUsageUsd ?? 0;
    const lim = d.data?.limits?.maxMonthlyUsageUsd ?? 0;
    const left = lim - used;
    const resets = (d.data?.monthlyUsageCycle?.endAt || '').slice(0, 10);
    if (left > 0.10) apifyUsable++;
    else warn('Apify', `\`${label}\` is capped ($${used.toFixed(2)}/$${lim}) — frees ${resets}`);
  } catch (e) { warn('Apify', `\`${label}\` check failed: ${String(e.message).slice(0, 50)}`); }
}
if (!apifyTokens.length) fail('Apify', 'no tokens configured at all');
else if (apifyUsable === 0) fail('Apify', `ALL ${apifyTokens.length} account(s) capped — Zillow valuation is DOWN. Add a token or fund one.`);

// ── 2. Claude CLI (the free AI extractor depends on this subscription staying logged in) ──
{
  const r = await sh('bash', ['-lc', 'claude -p "reply with exactly: OK"'], 120000);
  if (!r.ok || !/\bOK\b/i.test(r.out)) {
    fail('Claude CLI', `\`claude -p\` did not respond — AI extraction is DOWN. ${(r.err || r.out).slice(0, 90)}`);
  }
}

// ── 3. CapSolver (irreducible dependency — the Orange clerk is behind reCAPTCHA) ──
if (env.CAPSOLVER_API_KEY) {
  try {
    const d = await fetch('https://api.capsolver.com/getBalance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: env.CAPSOLVER_API_KEY }), signal: AbortSignal.timeout(20000),
    }).then(r => r.json());
    const bal = Number(d.balance ?? -1);
    if (bal < 0) fail('CapSolver', 'balance check failed — key may be invalid');
    else if (bal < 1) fail('CapSolver', `balance $${bal.toFixed(2)} — clerk scans will STOP. Top up.`);
    else if (bal < 3) warn('CapSolver', `balance $${bal.toFixed(2)} getting low`);
  } catch { warn('CapSolver', 'balance check failed'); }
} else fail('CapSolver', 'CAPSOLVER_API_KEY missing');

// ── 4. Did the daily scan actually run, and did it produce anything? ───────────
{
  const f = join(ROOT, 'scan-status.json');
  if (!existsSync(f)) warn('Daily scan', 'no scan-status.json — has the scan ever run here?');
  else {
    const ageH = (Date.now() - statSync(f).mtimeMs) / 3600000;
    if (ageH > 30) fail('Daily scan', `last run was ${Math.round(ageH)}h ago — the 7am timer is not firing`);
    else {
      try {
        const s = JSON.parse(readFileSync(f, 'utf8'));
        if (s.total > 0 && (s.knock || 0) === 0 && (s.review || 0) === s.total) {
          warn('Daily scan', `${s.total} cases scanned but 0 usable — extraction may have collapsed`);
        }
      } catch { /* unreadable status is not itself an outage */ }
    }
  }
}

// ── 5. Extraction health: cases scraped but missing their documents ────────────
// This is the check that would have caught 2026-07-26 on the morning it happened instead of
// two weeks later.
{
  const cnt = async q => (await q).count ?? 0;
  const base = () => sb.from('foreclosure_leads').select('*', { count: 'exact', head: true }).eq('county', 'Orange');
  const noDoc = await cnt(base().is('complaint_url', null).is('value_url', null));
  const total = await cnt(base());
  const withAddr = await cnt(base().not('property_address', 'is', null));
  if (total) {
    const docGapPct = Math.round(100 * noDoc / total);
    const addrPct = Math.round(100 * withAddr / total);
    if (docGapPct > 30) fail('Documents', `${noDoc}/${total} cases (${docGapPct}%) have NO document saved — the docket fetch is failing`);
    if (addrPct < 30) fail('Extraction', `only ${addrPct}% of cases have an address — parser or docs are broken`);
    else if (addrPct < 45) warn('Extraction', `${addrPct}% of cases have an address`);
  }

  // Fresh cases still missing docs a day later = the fetch failed, not "docs not posted yet".
  const since = new Date(Date.now() - 36 * 3600000).toISOString();
  const { count: freshNoDoc } = await sb.from('foreclosure_leads')
    .select('*', { count: 'exact', head: true })
    .gte('scanned_at', since).is('complaint_url', null).is('value_url', null);
  if ((freshNoDoc || 0) > 5) warn('Documents', `${freshNoDoc} cases scanned in the last 36h have no document attached`);
}

// ── 6. Is the dashboard actually serving? ──────────────────────────────────────
{
  const r = await sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', 'http://127.0.0.1:3001/foreclosures'], 25000);
  if (r.out.trim() !== '200') fail('Dashboard', `port 3001 returned ${r.out.trim() || 'nothing'} — \`systemctl restart dealfinder-web\``);
}

// ── report ─────────────────────────────────────────────────────────────────────
const healthy = problems.length === 0 && warnings.length === 0;
if (healthy && process.env.ALWAYS !== '1') { log('all clear — staying quiet'); process.exit(0); }

const lines = [
  problems.length ? `🚨 *DealFinder needs attention*` : `⚠️ *DealFinder warnings*`,
  '',
  ...problems,
  ...(problems.length && warnings.length ? [''] : []),
  ...warnings,
  '',
  `_${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET · VPS_`,
];
if (healthy) lines.splice(0, lines.length, '✅ *DealFinder healthy* — all checks passed', '', `_${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET · VPS_`);
const text = lines.join('\n');

console.log('\n' + text.replace(/\*/g, '') + '\n');

if (process.env.DRY === '1') { log('DRY=1 — not sending'); process.exit(0); }
const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
if (!token || !chat) { log('no telegram config — cannot alert'); process.exit(1); }
try {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  }).then(r => r.json());
  log(r.ok ? 'alert sent' : `telegram refused: ${JSON.stringify(r).slice(0, 120)}`);
} catch (e) { log('telegram send failed:', String(e.message).slice(0, 80)); }
process.exit(problems.length ? 1 : 0);
