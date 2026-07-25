// Diagnostic: replicate run-month.mjs's Orange clerk search (myeclerk) once and dump exactly what
// the results page shows — row count, any error banner, screenshot → /tmp/df-probe-clerk.
// Run: node scripts/probe-orange-clerk.mjs [DATE_FROM] [DATE_TO]   (M/D/yy, defaults last 3 days)
import { Camoufox } from 'camoufox-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const CAP = env.CAPSOLVER_API_KEY;
const OUT = '/tmp/df-probe-clerk';
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

const fmt = d => `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
const to = new Date(), from = new Date(); from.setDate(from.getDate() - 3);
const DATE_FROM = process.argv[2] || fmt(from), DATE_TO = process.argv[3] || fmt(to);

log(`solving captcha…`);
const c = await post('https://api.capsolver.com/createTask', { clientKey: CAP, task: { type: 'ReCaptchaV2EnterpriseTaskProxyLess', websiteURL: 'https://myeclerk.myorangeclerk.com/Cases/Search', websiteKey: '6LdtOBETAAAAABvi0Md4UUqb7GKfkRiUR6AsrFX-' } });
let tok = null;
for (let i = 0; i < 30 && c.taskId; i++) { await sleep(3000); const r = await post('https://api.capsolver.com/getTaskResult', { clientKey: CAP, taskId: c.taskId }); if (r.status === 'ready') { tok = r.solution.gRecaptchaResponse; break; } if (r.status === 'failed' || r.errorId) { log('capsolver FAILED:', r.errorDescription); break; } }
if (!tok) { log('no captcha token — aborting'); process.exit(1); }
log('token OK; searching', DATE_FROM, '→', DATE_TO);

const ctx = await Camoufox({ headless: true, user_data_dir: `/tmp/camou-probe-clerk-${process.pid}` });
await ctx.addInitScript((t) => { window.__captok = t; const f = () => Promise.resolve(window.__captok); let g; Object.defineProperty(window, 'grecaptcha', { configurable: true, get() { return g; }, set(v) { g = v; try { if (v) { v.execute = f; v.getResponse = () => window.__captok; v.ready = cb => cb && cb(); if (v.enterprise) { v.enterprise.execute = f; v.enterprise.getResponse = () => window.__captok; v.enterprise.ready = cb => cb && cb(); } } } catch (e) {} } }); }, tok);
const p = ctx.pages()[0] || await ctx.newPage();
try {
  const resp = await p.goto('https://myeclerk.myorangeclerk.com/Cases/Search', { waitUntil: 'domcontentloaded' });
  log('search page HTTP', resp?.status());
  await sleep(2000);
  await p.evaluate(({ df, dt }) => { const t = document.querySelector('button.multiselect,.btn-group .multiselect,[class*=multiselect].dropdown-toggle'); if (t) t.click(); const f = document.querySelector('#input-caseTypes'); if (f) { f.value = 'Foreclosure'; f.dispatchEvent(new Event('keyup', { bubbles: true })); } const cb = document.querySelector('input[type=checkbox][value="42"]'); if (cb && !cb.checked) cb.click(); const d = document.querySelector('#DateFrom'); if (d) { d.value = df; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); } const d2 = document.querySelector('#DateTo'); if (d2) { d2.value = dt; d2.dispatchEvent(new Event('input', { bubbles: true })); d2.dispatchEvent(new Event('change', { bubbles: true })); } if (t) t.click(); }, { df: DATE_FROM, dt: DATE_TO });
  await p.evaluate((t) => { window.__captok = t; let ta = document.getElementById('g-recaptcha-response'); if (!ta) { ta = document.createElement('textarea'); ta.id = 'g-recaptcha-response'; ta.name = 'g-recaptcha-response'; ta.style.display = 'none'; (document.querySelector('form') || document.body).appendChild(ta); } ta.value = t; const el = document.querySelector('[data-callback]'); const cb = el && el.getAttribute('data-callback'); if (cb && typeof window[cb] === 'function') { try { window[cb](t); } catch (e) {} } const btn = document.querySelector('#caseSearch'); if (btn) btn.removeAttribute('disabled'); }, tok);
  await Promise.all([p.waitForLoadState('networkidle').catch(() => {}), p.click('#caseSearch', { force: true }).catch(() => {})]);
  await p.waitForTimeout(4000);
  const url = p.url();
  const rows = await p.evaluate(() => document.querySelectorAll('#caseList tbody tr').length).catch(() => -1);
  const text = await p.evaluate(() => document.body.innerText).catch(() => '');
  writeFileSync(join(OUT, 'results.txt'), `URL: ${url}\nROWS: ${rows}\n\n${text}`);
  writeFileSync(join(OUT, 'results.html'), await p.content().catch(() => ''));
  await p.screenshot({ path: join(OUT, 'results.png'), fullPage: true }).catch(e => log('shot failed:', e.message.slice(0, 50)));
  log('final URL:', url);
  log('#caseList rows:', rows);
  log('page mentions:', ['error', 'captcha', 'no results', 'no cases', 'denied', 'blocked', 'unusual traffic'].filter(k => text.toLowerCase().includes(k)).join(', ') || '(none of the usual error words)');
  log('body text first 400:', text.replace(/\s+/g, ' ').slice(0, 400));
  log('wrote', OUT);
} finally { await ctx.close().catch(() => {}); }
process.exit(0);
