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
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';
import { send as tgSend, esc } from './notify-telegram.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[health]', ...a);

const problems = [];   // things that are broken NOW
const warnings = [];   // things that will break soon
const fail = (area, msg) => problems.push(`❌ *${area}* — ${msg}`);
const warn = (area, msg) => warnings.push(`⚠️ *${area}* — ${msg}`);

// The `claude` CLI treats ANTHROPIC_API_KEY as an auth source and PREFERS it over the Max
// subscription login — with it set, every call dies on "Credit balance is too low" even
// though the subscription is healthy. .env carries it for the legacy metered path, so strip
// it here rather than depending on every caller's environment being clean.
delete process.env.ANTHROPIC_API_KEY;

const sh = (cmd, args, timeout = 60000) => new Promise(r =>
  execFile(cmd, args, { timeout, maxBuffer: 4e6 }, (e, so, se) =>
    r({ ok: !e, out: String(so || ''), err: String(se || e?.message || '') })));

// ── PROBE MODE (`--probe` / `--uptime`) — same script, second cadence ──────────
// The deep checks below run 2x/day. That cadence cannot catch "the site died at 09:00 and
// nobody knew until 20:00" — and 2026-07-12→14 proved silence reads as health. So the SAME
// script has a fast mode, run every 2 minutes by dealfinder-probe.timer:
//   · hits the two endpoints a user actually needs (dashboard page + deals API), asserting
//     HTTP 200 AND a body that looks like the real app — a 200 error shell is still DOWN
//   · debounced: alerts only after PROBE_FAILS consecutive failures (default 3 ≈ 6 min), so
//     the ~6s Restart=always respawn blip never pages anyone
//   · alerts on TRANSITION, reminds hourly while down, and sends a recovery message with the
//     outage duration — but only if a down alert actually went out
//   · dead-man's-switch: pages if the 07:00 daily scan has no SUCCESS in 26h, and yellow-flags
//     a completed scan that reported 0 new leads (the silent-zero failure mode)
// Each probe is a oneshot process, so debounce state lives on disk (StateDirectory=dealfinder
// → /var/lib/dealfinder, writable by the `vantis` user the unit runs as).
// Alerts reuse notify-telegram's send() — one Telegram client — but are styled DF OPS with
// traffic-light emoji so a system page never looks like the daily 🚪 lead report. They go to
// the primary chat only (same audience as the deep-check alerts; partners on
// TELEGRAM_RECEIVERS get leads, not pager noise).
// Test knobs: PROBE_BASE=http://127.0.0.1:9 forces failure without touching the real site;
// PROBE_STATE, PROBE_FAILS, PROBE_REMIND_MIN, PROBE_HEARTBEAT_MAX_H override defaults.
if (process.argv.includes('--probe') || process.argv.includes('--uptime')) {
  await runProbe();
  process.exit(process.exitCode || 0);
}

async function runProbe() {
  const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
  const NFAILS = Math.max(2, parseInt(process.env.PROBE_FAILS || '3', 10));
  const REMIND_MS = parseInt(process.env.PROBE_REMIND_MIN || '60', 10) * 60000;
  const HB_MAX_MS = parseFloat(process.env.PROBE_HEARTBEAT_MAX_H || '26') * 3600000;
  const STATE = process.env.PROBE_STATE || '/var/lib/dealfinder/probe-state.json';
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  const now = Date.now();
  const et = ts => new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const mins = ms => { const m = Math.round(ms / 60000); return m < 120 ? `${m} min` : `${(ms / 3600000).toFixed(1)}h`; };

  let st = {};
  try { st = JSON.parse(readFileSync(STATE, 'utf8')) || {}; } catch { /* first run — empty state */ }

  const ops = async text => {
    if (!token || !chat) { log('probe: no TELEGRAM_BOT_TOKEN/CHAT_ID — cannot alert'); return { ok: false }; }
    const r = await tgSend(token, chat, text);
    log('probe: telegram →', JSON.stringify(r).slice(0, 300));
    return r;
  };

  // ── uptime: HTTP 200 + a body that is actually the app ──
  // Timeouts are deliberately TIGHT. A Node process under MemoryHigh reclaim pressure stays
  // alive and `active (running)` while taking 30s+ to answer — Restart=always never fires
  // because nothing exited. SLOW MUST FAIL, not just dead, or the hang is invisible.
  const TMO = parseInt(process.env.PROBE_TIMEOUT_MS || '5000', 10);
  const failures = [];
  try {
    const r = await fetch(BASE + '/foreclosures', { signal: AbortSignal.timeout(TMO) });
    const body = await r.text();
    if (r.status !== 200) failures.push(`/foreclosures → HTTP ${r.status}`);
    else if (body.length < 3000 || !/<!doctype html>/i.test(body) || !body.includes('/_next/'))
      failures.push(`/foreclosures → 200 but body is not the app (${body.length}B)`);
  } catch (e) { failures.push(`/foreclosures → unreachable (${String(e.cause?.code || e.message).slice(0, 40)})`); }
  try {
    const r = await fetch(BASE + '/api/deals', { signal: AbortSignal.timeout(TMO * 2) });
    const body = await r.text();
    let j = null; try { j = JSON.parse(body); } catch { /* not JSON = broken */ }
    if (r.status !== 200) failures.push(`/api/deals → HTTP ${r.status}`);
    else if (!Array.isArray(j?.deals)) failures.push('/api/deals → 200 but no deals[] payload');
    else if (j.deals.length === 0) failures.push('/api/deals → 0 deals — DB empty or query broken');
  } catch (e) { failures.push(`/api/deals → unreachable (${String(e.cause?.code || e.message).slice(0, 40)})`); }

  // ── PUBLIC vantage: the path a human actually uses ──
  // The 127.0.0.1 checks above prove the PROCESS is alive. They are structurally blind to the
  // box being unreachable from OUTSIDE — DNS gone, traefik down, cert expired, firewall shut.
  // That is precisely the failure Phillip reported on 2026-08-05: the process was fine, but he
  // had no working URL. A local-only probe would have reported "all healthy" that whole time.
  const PUBLIC = String(env.DEAL_FINDER_URL || '').replace(/\/+$/, '');
  if (PUBLIC && !PUBLIC.startsWith(BASE)) {
    try {
      const r = await fetch(PUBLIC + '/foreclosures', { signal: AbortSignal.timeout(TMO * 2), redirect: 'follow' });
      const body = await r.text();
      if (r.status !== 200) failures.push(`public ${PUBLIC} → HTTP ${r.status}`);
      else if (body.length < 3000 || !body.includes('/_next/'))
        failures.push(`public ${PUBLIC} → 200 but body is not the app (${body.length}B)`);
    } catch (e) { failures.push(`public ${PUBLIC} → unreachable (${String(e.cause?.code || e.message).slice(0, 40)}) — DNS/traefik/TLS, not the app`); }
  }

  if (failures.length) {
    st.consecFails = (st.consecFails || 0) + 1;
    st.downSince = st.downSince || now;
    st.lastFailures = failures;
    log(`probe: FAIL ${st.consecFails}/${NFAILS} — ${failures.join(' · ')}`);
    if (st.consecFails >= NFAILS && !st.alertedAt) {
      await ops([
        '🔴 <b>DF OPS — SITE DOWN</b>',
        ...failures.map(f => `• ${esc(f)}`),
        `${st.consecFails} consecutive probe failures since ${et(st.downSince)} ET. Reminders hourly until it recovers.`,
        '<code>systemctl status dealfinder-web</code> · <code>tail -30 /var/log/dealfinder/web.log</code>',
      ].join('\n'));
      st.alertedAt = now; st.lastReminderAt = now;
    } else if (st.alertedAt && now - (st.lastReminderAt || 0) >= REMIND_MS) {
      await ops(`🔴 <b>DF OPS — STILL DOWN</b>\nDown ${mins(now - st.downSince)} (since ${et(st.downSince)} ET).\n${failures.map(f => `• ${esc(f)}`).join('\n')}`);
      st.lastReminderAt = now;
    }
  } else {
    if (st.alertedAt) {
      await ops(`🟢 <b>DF OPS — RECOVERED</b>\nSite is back up after ${mins(now - st.downSince)} down (since ${et(st.downSince)} ET).`);
    }
    if (st.consecFails) log(`probe: OK again after ${st.consecFails} fail(s)${st.alertedAt ? '' : ' — blip, below alert threshold, no page sent'}`);
    delete st.downSince; delete st.alertedAt; delete st.lastReminderAt; delete st.lastFailures;
    st.consecFails = 0;
    st.lastOkAt = now;
  }

  // ── crash-loop: the check without which this whole watchdog is decorative ──
  // A service dying and respawning on RestartSec=5 boots in ~280ms, so it serves HTTP 200 for
  // ~4.7 of every 5.3 seconds — about 88% of the time. A point-in-time probe therefore reads a
  // PERMANENT crash-loop as perfectly healthy, at any polling interval. NRestarts is the only
  // honest signal. It counts AUTOMATIC restarts only — a deliberate `systemctl restart` does not
  // bump it — so any increase between probes means the service died on its own.
  try {
    const r = await sh('systemctl', ['show', 'dealfinder-web.service', '-p', 'NRestarts', '-p', 'ActiveState'], 10000);
    const nr = Number((r.out.match(/NRestarts=(\d+)/) || [])[1] ?? NaN);
    const state = (r.out.match(/ActiveState=(\S+)/) || [])[1] || 'unknown';
    if (Number.isFinite(nr)) {
      if (Number.isFinite(st.lastRestarts) && nr > st.lastRestarts) {
        const n = nr - st.lastRestarts;
        await ops([
          '🔁 <b>DF OPS — CRASH LOOP</b>',
          `<code>dealfinder-web</code> auto-restarted <b>${n}×</b> since the last probe (NRestarts ${st.lastRestarts}→${nr}); systemd reports <code>${esc(state)}</code>.`,
          'It is flapping, not stable — a passing HTTP check does NOT mean healthy here.',
          '<code>journalctl -u dealfinder-web -n 50 --no-pager</code>',
        ].join('\n'));
      }
      st.lastRestarts = nr;
    }
  } catch { /* systemctl unavailable — HTTP checks above still stand */ }

  // ── dead-man's-switch: the 07:00 daily scan must keep proving it ran ──
  // systemd is the source of truth for "did the unit finish, and with what exit":
  // scan-status.json is rewritten by ad-hoc/settings scans (verified 2026-08-05 — file said
  // 19:38 while the daily ran 07:02) and daily.log rotates weekly, so neither pins down the
  // TIMER's own outcome. ExecMainExitTimestamp clears on reboot, so the newest success seen
  // is persisted in probe state and survives restarts.
  try {
    const r = await sh('systemctl', ['show', 'dealfinder-daily.service', '-p', 'ExecMainExitTimestamp', '-p', 'ExecMainStatus', '-p', 'Result'], 10000);
    const p = Object.fromEntries(r.out.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const ts = Date.parse(String(p.ExecMainExitTimestamp || '').replace(/^[A-Za-z]+ /, ''));
    if (Number.isFinite(ts) && p.ExecMainStatus === '0' && p.Result === 'success' && ts > (st.lastDailySuccess || 0)) st.lastDailySuccess = ts;
  } catch { /* systemctl unavailable — fall back to last persisted success */ }
  if (!st.lastDailySuccess) st.lastDailySuccess = now; // first install arms the switch from now
  if (now - st.lastDailySuccess > HB_MAX_MS) {
    if (!st.hbAlertedAt || now - st.hbAlertedAt >= 24 * 3600000) {
      await ops(`🟠 <b>DF OPS — DAILY SCAN MISSING</b>\nNo successful daily scan for ${mins(now - st.lastDailySuccess)} (expected 07:00 ET; last success ${et(st.lastDailySuccess)} ET). Absence of the report is itself the alarm.\n<code>systemctl status dealfinder-daily</code> · <code>tail -40 /var/log/dealfinder/daily.log</code>`);
      st.hbAlertedAt = now;
    }
  } else delete st.hbAlertedAt;

  // ── silent-zero: scan COMPLETED but reported nothing — how Jul 12–14 read as "quiet days" ──
  // The daily run logs its own notify result (`telegram: {"sent":N,...}`); a completed run with
  // sent:0 gets ONE yellow flag for that date, so a real quiet day costs one glance, and a dead
  // valuation pipeline can no longer hide behind three of them.
  try {
    const dl = readFileSync('/var/log/dealfinder/daily.log', 'utf8');
    const m = [...dl.matchAll(/^(\d{4}-\d{2}-\d{2})T[\d:]+ telegram: (\{.*\})$/gm)].pop();
    if (m && now - st.lastDailySuccess < HB_MAX_MS) {
      const sent = JSON.parse(m[2]).sent ?? null;
      if (sent === 0 && st.zeroFlaggedDate !== m[1]) {
        await ops(`🟡 <b>DF OPS — SCAN RAN, 0 FLAGGED</b>\nThe ${m[1]} scan completed but flagged 0 new leads. Could be a quiet day — could be the Jul 12 silent-zero mode (valuation dead → nothing flags). Spot-check: <code>tail -40 /var/log/dealfinder/daily.log</code>`);
        st.zeroFlaggedDate = m[1];
      }
    }
  } catch { /* log missing/rotated — the dead-man's-switch above still covers absence */ }

  try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(st, null, 2)); }
  catch (e) { log('probe: CANNOT WRITE STATE', STATE, '—', e.message, '— debounce is broken until perms are fixed'); process.exitCode = 1; }
}

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
    // Say WHAT is broken, not what we assume is broken. On 2026-08-01 this read "the docket
    // fetch is failing" and sent Phillip after the scraper — but the scraper was fine. The
    // documents downloaded and then failed to UPLOAD to Supabase Storage (timeouts, plus files
    // over the size limit). A diagnosis in an alert is a claim; make it point at evidence.
    if (docGapPct > 30) fail('Documents', `${noDoc}/${total} cases (${docGapPct}%) have no document stored — check \`grep "upload FAILED" /var/log/dealfinder/daily.log\` for storage errors before suspecting the scraper`);
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
