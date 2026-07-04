// Lake County foreclosure scraper — equivant ShowCase SPA (courtrecords.lakecountyclerk.org).
// Flow (mapped by sight, per visual-web-recon): Case Search → Court Type = Circuit Civil + date window →
// results → open each case → Case Type must be a FORECLOSURE → Dockets tab → click the COMPLAINT + VALUE
// docket docs → capture the application/pdf (POST /sci/docket/document) → address + owed → upsert
// foreclosure_leads (county='Lake'). Bank-only filter + Apify Zillow back-half, same as Orange/Seminole.
//
// Run headed:  HEADED=1 node scripts/run-lake.mjs        Window: DAYS=N (default 3) or DATE_FROM/DATE_TO (ISO)
import { Camoufox } from 'camoufox-js';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from './_env.mjs';
import { saveDocToStorage } from './_storage.mjs';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const env = loadEnv(ROOT);
const BASE = 'https://courtrecords.lakecountyclerk.org';
const HEADED = process.env.HEADED === '1';
const USE_AI = process.env.USE_AI !== '0';
const MAX_CASES = parseInt(process.env.MAX_CASES || '0', 10); // 0 = all in window (testing cap)
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;   // ShowCase requires MM/DD/YYYY

// Bank-only filters (same intent as Seminole/Orange).
const dropPlaintiff = /\bassociation\b|\bassoc\b|\bH\.?\s?O\.?\s?A\b|homeowner|condominium|\bcondo\b|property\s+owners|townhom\w*/i;
const bankPlaintiff = /\bbank\b|national\s+association|\bN\.?\s?A\.?\b|mortgage|\bloan|\btrust\b|financ|federal|savings|servic|lender|credit\s+union|fargo|chase|citi|wells|fannie|freddie|rocket|nationstar|loandepot|carrington|newrez|freedom|villa?ge capital|wilmington/i;
const govPlaintiff = /^\s*lake county\b|\bcity of\b|\bstate of florida\b|tax collector|code enforcement|clerk of\b/i;

const now = new Date();
const MONTH = now.getMonth() + 1, YEAR = now.getFullYear();
const isoToMDY = s => { const [Y, M, D] = s.split('-').map(Number); return `${pad(M)}/${pad(D)}/${Y}`; };
let DATE_FROM, DATE_TO;
if (process.env.DATE_FROM) { DATE_FROM = isoToMDY(process.env.DATE_FROM); DATE_TO = isoToMDY(process.env.DATE_TO || now.toISOString().slice(0, 10)); }
else { const days = parseInt(process.env.DAYS || '3', 10); const f = new Date(now); f.setDate(f.getDate() - days); DATE_FROM = fmt(f); DATE_TO = fmt(now); }

// ---- back-half (address + owed) — same recipe as Orange/Seminole ----
function pdftext(file) { try { return execFileSync('pdftotext', [file, '-'], { maxBuffer: 2e8 }).toString(); } catch (e) { return ''; } }
function filingDate(file) { try { const t = execFileSync('pdftotext', ['-l', '1', file, '-'], { maxBuffer: 5e7 }).toString(); const m = t.match(/E-?Filed:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i) || t.match(/\bFiled:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i); return m ? `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : null; } catch (e) { return null; } }
function isCleanAddr(s) { return !!s && /^\d/.test(s) && !/[\[\]{}]/.test(s) && /\bFL(?:ORIDA)?\b\s*\d{5}/i.test(s) && !/described|security instrument|lender|servic/i.test(s); }
function addrAnchor(raw) {
  const lines = raw.split('\n').map(l => l.replace(/\s{2,}/g, ' ').trim());
  for (let i = 0; i < lines.length; i++) {
    if (/\[\s*property address\s*\]/i.test(lines[i])) {
      const prev = [];
      for (let j = i - 1; j >= 0 && prev.length < 4; j--) { const ln = lines[j]; if (!ln || /^[\[(].*[\])]$/.test(ln) || /described in the|security instrument|^lender|note dated/i.test(ln)) continue; prev.unshift(ln); }
      const ci = prev.findIndex(l => /\bFL\b\s*\d{5}|Florida\s*\d{5}/i.test(l));
      if (ci >= 0) { const street = ci > 0 ? prev[ci - 1] : ''; const out = `${street ? street + ', ' : ''}${prev[ci]}`.replace(/\s*,\s*/g, ', ').replace(/\s{2,}/g, ' ').trim(); if (isCleanAddr(out)) return out; }
    }
  }
  return null;
}
async function addrAI(raw) {
  try {
    let snip = ''; const re = /\[\s*property address\s*\]|located at/ig; let m, n = 0;
    while ((m = re.exec(raw)) && n < 2) { snip += raw.slice(Math.max(0, m.index - 1400), m.index + 250) + '\n…\n'; n++; }
    if (!snip) snip = raw.slice(0, 9000); snip = snip.replace(/[ \t]+/g, ' ').slice(0, 6000);
    const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: `Text from a Florida mortgage foreclosure complaint. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed (labeled "[Property Address]" or right after "located at"). NOT the lender/servicer/law-firm/agent address. Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.\n\n${snip}` }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return j.address && /\d/.test(j.address) ? String(j.address).replace(/\s{2,}/g, ' ').trim() : null;
  } catch (e) { return null; }
}
// Vision fallback — Lake complaints are often scanned images (no text layer), so read the PDF directly.
async function addrVision(file) {
  try {
    const b64 = readFileSync(file).toString('base64');
    const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida mortgage foreclosure complaint. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed (NOT the lender/servicer/law-firm/agent address). Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.' }] }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return j.address && /\d/.test(j.address) ? String(j.address).replace(/\s{2,}/g, ' ').trim() : null;
  } catch (e) { return null; }
}
async function addr(file) {
  const raw = pdftext(file);
  const quick = addrAnchor(raw);
  if (quick) return quick;
  if (USE_AI && raw.replace(/\s/g, '').length > 300) { const a = await addrAI(raw); if (a) return a; } // has a text layer
  return USE_AI ? await addrVision(file) : null;                                                        // scanned image → read the PDF
}
async function owedOCR(file) { const tmp = join(tmpdir(), `lake-ocr-${process.pid}-${Math.random().toString(36).slice(2)}`); try { await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]); const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 5e7 }); const p = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Principal due/i), i = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest owed/i); return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null }; } catch (e) { return {}; } finally { try { unlinkSync(`${tmp}.png`); } catch (e) {} } }
async function owedAI(file) { try { const b64 = readFileSync(file).toString('base64'); const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only.' }] }] }); const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]); return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) }; } catch (e) { return {}; } }
async function owed(file) { const r = await owedOCR(file); if (r.principalDue != null || r.interestOwed != null) return r; return USE_AI ? owedAI(file) : r; }

async function upsertLead(rec) {
  try {
    await sb.from('foreclosure_leads').upsert({
      case_number: rec.caseNumber, county: 'Lake', plaintiff: rec.plaintiff || null, defendant: rec.defendant || null, type: rec.type || null,
      property_address: rec.propertyAddress || null, principal_due: rec.principalDue ?? null, interest_owed: rec.interestOwed ?? null,
      total_owed: rec.totalOwed ?? null, owed_with_buffer: rec.owedWithBuffer ?? null,
      review_status: rec.reviewStatus || null, review_reason: rec.reviewReason || null,
      complaint_url: rec.complaintUrl || null, value_url: rec.valueUrl || null, docket_url: rec.docketUrl || null,
      filing_date: rec.filingDate || null, scan_month: MONTH, scan_year: YEAR, updated_at: new Date().toISOString(),
    }, { onConflict: 'case_number' });
  } catch (e) { log('upsert err', String(e.message).slice(0, 50)); }
}

// ---- ShowCase front-half ----
// Click a docket row's document button (by description) and capture the application/pdf it loads.
async function fetchDocByDesc(page, re) {
  let resolve; const p = new Promise(r => (resolve = r));
  const onResp = async (r) => { try { const ct = (r.headers()['content-type'] || '').toLowerCase(); if (/pdf|octet/.test(ct)) { const b = Buffer.from(await r.body()); if (b.slice(0, 5).toString('latin1') === '%PDF-') resolve(b); } } catch (e) {} };
  const ctxx = page.context();
  const onPage = (pg) => pg.on('response', onResp);
  page.on('response', onResp); ctxx.on('page', onPage);   // catch the PDF whether it's on the main page or a popup
  const clicked = await page.evaluate((src) => {
    const row = [...document.querySelectorAll('table tbody tr')].find(r => new RegExp(src, 'i').test(r.innerText || ''));
    if (!row) return false;
    const btn = row.querySelector('button.btn-link,[aria-label*="document" i]');
    if (btn) { btn.click(); return true; } return false;
  }, re.source);
  const buf = clicked ? await Promise.race([p, sleep(20000).then(() => null)]) : null;
  page.off('response', onResp); ctxx.off('page', onPage);
  return buf;
}

console.log(`\n=== Lake foreclosure scan (ShowCase) — ${DATE_FROM} → ${DATE_TO} | ${HEADED ? 'HEADED' : 'headless'} ===\n`);
const ctx = await Camoufox({ headless: !HEADED, user_data_dir: join(tmpdir(), `camou-lake-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
p.on('dialog', d => d.accept().catch(() => {}));
let searchJson = null;   // capture the SPA's own search response (has caseNumber + sid + caseType + plaintiff)
p.on('response', async r => { if (/\/sci\/case\/search/.test(r.url())) { try { searchJson = await r.json(); } catch (e) {} } });
let saved = 0, knock = 0, review = 0;
try {
  log('opening ShowCase…');
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4500);
  await p.evaluate(() => { const a = [...document.querySelectorAll('a,button')].find(x => /case search/i.test((x.innerText || '').trim())); if (a) a.click(); });
  await sleep(2500);
  // Court Type = Circuit Civil
  await p.evaluate(() => { const sels = [...document.querySelectorAll('select')]; const ct = sels.find(s => [...s.options].some(o => /circuit civil/i.test(o.text))); const o = [...ct.options].find(x => /circuit civil/i.test(x.text)); ct.value = o.value; ct.dispatchEvent(new Event('change', { bubbles: true })); });
  const set = async (n, v) => { const el = await p.$(`input[name="${n}"]`); if (el) { await el.click(); await el.fill(''); await el.type(v, { delay: HEADED ? 40 : 15 }); } };
  await set('fromDate', DATE_FROM); await set('toDate', DATE_TO); await sleep(500);
  log(`searching Circuit Civil ${DATE_FROM} → ${DATE_TO}…`);
  await p.evaluate(() => { const b = [...document.querySelectorAll('button,input[type=submit],a')].find(x => /^\s*search\s*$/i.test((x.innerText || x.value || '').trim())); if (b) b.click(); });
  await sleep(6000);
  if (process.env.DEBUG_SHOT) await p.screenshot({ path: process.env.DEBUG_SHOT, fullPage: true }).catch(() => {});
  // Read the SPA's own search response — it carries caseNumber + sid + caseType + plaintiff. Filter to foreclosures.
  const recs = Array.isArray(searchJson) ? searchJson : [];
  const seen = new Set();
  let cases = recs.filter(r => /foreclos/i.test(r.caseType || '') && r.sid && !seen.has(r.caseNumber) && seen.add(r.caseNumber))
    .map(r => ({ num: r.caseNumber, sid: r.sid, type: r.caseType, plaintiff: (r.lastName || '').replace(/,\s*$/, '') }));
  if (MAX_CASES) cases = cases.slice(0, MAX_CASES);
  log(`found ${recs.length} Circuit-Civil rows → ${cases.length} foreclosure case(s)\n`);

  for (const c of cases) {
    const rec = { caseNumber: c.num, type: c.type, plaintiff: c.plaintiff, reviewStatus: 'auto', reviewReason: null };
    try {
      const isHoa = dropPlaintiff.test(c.plaintiff) && !bankPlaintiff.test(c.plaintiff);
      const isGov = govPlaintiff.test(c.plaintiff);
      if (isHoa) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'hoa_plaintiff'; }
      else if (isGov) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'gov_plaintiff'; }
      else {
        // direct nav to the case (no goBack/index drift), open Dockets, download Complaint + Value
        await p.goto(`${BASE}/casedetails/${c.sid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await p.waitForFunction(() => /Dockets/i.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
        await sleep(1200);
        rec.docketUrl = p.url();
        await p.evaluate(() => { const t = [...document.querySelectorAll('a,button,[ng-click]')].find(x => /^\s*dockets\s*$/i.test((x.innerText || '').trim())); if (t) t.click(); });
        await sleep(3000);
        const cmp = await fetchDocByDesc(p, /complaint/i);
        if (cmp) { const f = join(tmpdir(), `lake-c-${c.num.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, cmp); rec.propertyAddress = await addr(f); rec.filingDate = filingDate(f); try { unlinkSync(f); } catch (e) {} rec.complaintUrl = await saveDocToStorage(sb, c.num, 'complaint', cmp) || null; }
        await sleep(800);
        const val = await fetchDocByDesc(p, /value of real property/i);
        if (val) { const f = join(tmpdir(), `lake-v-${c.num.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, val); const o = await owed(f); rec.principalDue = o.principalDue; rec.interestOwed = o.interestOwed; try { unlinkSync(f); } catch (e) {} rec.valueUrl = await saveDocToStorage(sb, c.num, 'value', val) || null; }
        const o = (rec.principalDue || 0) + (rec.interestOwed || 0); rec.totalOwed = o || null; rec.owedWithBuffer = o ? o + 10000 : null;
        if (!rec.complaintUrl) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_complaint'; }
        else if (!rec.propertyAddress) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_address'; }
      }
    } catch (e) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'err:' + String(e.message).slice(0, 20); }
    await upsertLead(rec); saved++;
    if (rec.reviewStatus === 'manual_review') review++; else knock++;
    log(`  ${saved}/${cases.length} ${rec.caseNumber} | ${rec.plaintiff || '?'} | ${rec.propertyAddress || rec.reviewReason || '?'} | owed ${rec.owedWithBuffer || '—'} | ${rec.reviewStatus}`);
    await sleep(600);
  }
  if (HEADED) { log('\nscan done — closing in 8s…'); await sleep(8000); }
  await ctx.close().catch(() => {});
  if (process.env.SKIP_VALUE !== '1') {
    log('valuation pass (Apify Zillow)…');
    try { execFileSync(process.execPath, [join(__dirname, 'value-with-apify.mjs')], { stdio: 'inherit', env: process.env }); } catch (e) { log('valuation failed', String(e.message).slice(0, 60)); }
  }
  log(`\nLAKE DONE | saved ${saved} | knock ${knock} | review ${review}`);
} catch (e) { log('FATAL', e.message); } finally { await ctx.close().catch(() => {}); }
process.exit(0);
