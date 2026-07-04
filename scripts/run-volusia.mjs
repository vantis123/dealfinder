// Volusia County foreclosure scraper. Two public sources, no login/captcha to solve:
//   LEAD LIST  = static weekly Circuit-Civil foreclosure reports (app02.clerk.org/cm_rpt/circuit/CI_YYYY_MM_DD.html,
//                week-ending Saturday). Each lists NEW foreclosure suits: case #, plaintiff (bank/lender),
//                defendant, filing date. The report is ALL foreclosures → we just apply the bank-only filter.
//   DOC SOURCE = ccms.clerk.org (Volusia Case Inquiry, ASP.NET). Flow mapped by SIGHT (visual-web-recon):
//                Accept disclaimer (postback, no captcha; reCAPTCHA v3 passes natively in Camoufox) → search
//                by case number "YYYY NNNNN XXXX" → open case → Docket tab → the COMPLAINT / PETITION TO
//                FORECLOSE + WORKSHEET (= "Value of Real Property or Mortgage Foreclosure Claim" form) rows
//                each carry viewDocNoQueryString('<docid>') → viewDocument.aspx redacts then serves the PDF via
//                load_Redact.aspx (application/pdf) → address + owed → upsert foreclosure_leads (county='Volusia').
//
// SHARED BACK-HALF (address + owed + bank filter + upsert) is reused verbatim from run-lake.mjs; only the
// front-half (find new filings in a date window + fetch each case's Complaint + Value PDFs) is Volusia-specific.
//
// Envs (same as run-lake): DATE_FROM/DATE_TO (ISO) or DAYS (default 3); MAX_CASES (0 = all); SKIP_VALUE=1
// skips the Apify Zillow valuation pass; USE_AI=0 disables Claude fallbacks; HEADED=1 to watch it.
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
const CCMS = 'https://ccms.clerk.org';
const RPT = 'https://app02.clerk.org/cm_rpt/circuit'; // weekly Circuit-Civil foreclosure reports
const HEADED = process.env.HEADED === '1';
const USE_AI = process.env.USE_AI !== '0';
const MAX_CASES = parseInt(process.env.MAX_CASES || '0', 10); // 0 = all in window (testing cap)
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const pad = n => String(n).padStart(2, '0');

// Bank-only filters (verbatim from run-lake, with "volusia county" as the gov match).
const dropPlaintiff = /\bassociation\b|\bassoc\b|\bH\.?\s?O\.?\s?A\b|homeowner|condominium|\bcondo\b|property\s+owners|townhom\w*/i;
const bankPlaintiff = /\bbank\b|national\s+association|\bN\.?\s?A\.?\b|mortgage|\bloan|\btrust\b|financ|federal|savings|servic|lender|credit\s+union|fargo|chase|citi|wells|fannie|freddie|rocket|nationstar|loandepot|carrington|newrez|freedom|villa?ge capital|wilmington|pennymac|planet home|crosscountry|acrisure|onity|truist|citizens|southstate|lakeview|deutsche|pnc|us bank|u s bank/i;
const govPlaintiff = /^\s*volusia county\b|\bcity of\b|\bstate of florida\b|tax collector|code enforcement|clerk of\b/i;

const now = new Date();
const MONTH = now.getMonth() + 1, YEAR = now.getFullYear();
const isoToDate = s => { const [Y, M, D] = s.split('-').map(Number); return new Date(Y, M - 1, D); };
let FROM_D, TO_D;
if (process.env.DATE_FROM) { FROM_D = isoToDate(process.env.DATE_FROM); TO_D = process.env.DATE_TO ? isoToDate(process.env.DATE_TO) : new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
else { const days = parseInt(process.env.DAYS || '3', 10); TO_D = new Date(now.getFullYear(), now.getMonth(), now.getDate()); FROM_D = new Date(TO_D); FROM_D.setDate(FROM_D.getDate() - days); }
const DATE_FROM = `${pad(FROM_D.getMonth() + 1)}/${pad(FROM_D.getDate())}/${FROM_D.getFullYear()}`;
const DATE_TO = `${pad(TO_D.getMonth() + 1)}/${pad(TO_D.getDate())}/${TO_D.getFullYear()}`;

// ---- back-half (address + owed) — reused verbatim from run-lake ----
function pdftext(file) { try { return execFileSync('pdftotext', [file, '-'], { maxBuffer: 2e8 }).toString(); } catch (e) { return ''; } }
function filingDatePdf(file) { try { const t = execFileSync('pdftotext', ['-l', '1', file, '-'], { maxBuffer: 5e7 }).toString(); const m = t.match(/E-?Filed:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i) || t.match(/\bFiled:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i); return m ? `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : null; } catch (e) { return null; } }
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
    let snip = ''; const re = /\[\s*property address\s*\]|located at|property address/ig; let m, n = 0;
    while ((m = re.exec(raw)) && n < 3) { snip += raw.slice(Math.max(0, m.index - 1400), m.index + 250) + '\n…\n'; n++; }
    if (!snip) snip = raw.slice(0, 9000); snip = snip.replace(/[ \t]+/g, ' ').slice(0, 6000);
    const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: `Text from a Florida mortgage foreclosure complaint. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed (labeled "[Property Address]" or right after "located at"). NOT the lender/servicer/law-firm/agent address. Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.\n\n${snip}` }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return j.address && /\d/.test(j.address) ? String(j.address).replace(/\s{2,}/g, ' ').trim() : null;
  } catch (e) { return null; }
}
// Vision fallback — some complaints are scanned images (no text layer), so read the PDF directly.
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
// Volusia WORKSHEET ("Value of Real Property or Mortgage Foreclosure Claim") has a clean text layer — free +
// exact, tried before OCR/AI. Two form layouts exist: label-then-amount ("Principal Due on the Note - $89,456.42")
// and amount-then-label ("1. $ 49,826.09  Principal due on the note"). Use pdftotext -layout and grab the dollar
// figure sitting on the SAME line as each label (works for both), so column layouts aren't scrambled.
function owedText(file) {
  let t; try { t = execFileSync('pdftotext', ['-layout', file, '-'], { maxBuffer: 2e8 }).toString(); } catch (e) { return {}; }
  if (!/value of real property|principal due/i.test(t)) return {};
  const lines = t.split('\n');
  const amt = re => { const l = lines.find(x => re.test(x)); const m = l && l.match(/\$\s*([\d,]+\.\d{2})/); return m ? money(m[1]) : null; };
  return { principalDue: amt(/principal\s+due\s+on\s+the\s+note/i), interestOwed: amt(/interest\s+owed\s+on\s+the\s+note/i) };
}
async function owedOCR(file) { const tmp = join(tmpdir(), `vol-ocr-${process.pid}-${Math.random().toString(36).slice(2)}`); try { await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]); const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 5e7 }); const p = stdout.match(/Principal\s+Due[^$\n]*\$?\s*([\d,]+\.\d{2})/i) || stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Principal due/i); const i = stdout.match(/Interest\s+Owed[^$\n]*\$?\s*([\d,]+\.\d{2})/i) || stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest owed/i); return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null }; } catch (e) { return {}; } finally { try { unlinkSync(`${tmp}.png`); } catch (e) {} } }
async function owedAI(file) { try { const b64 = readFileSync(file).toString('base64'); const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only.' }] }] }); const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]); return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) }; } catch (e) { return {}; } }
async function owed(file) { let r = owedText(file); if (r.principalDue != null || r.interestOwed != null) return r; r = await owedOCR(file); if (r.principalDue != null || r.interestOwed != null) return r; return USE_AI ? owedAI(file) : r; }

async function upsertLead(rec) {
  try {
    await sb.from('foreclosure_leads').upsert({
      case_number: rec.caseNumber, county: 'Volusia', plaintiff: rec.plaintiff || null, defendant: rec.defendant || null, type: rec.type || null,
      property_address: rec.propertyAddress || null, principal_due: rec.principalDue ?? null, interest_owed: rec.interestOwed ?? null,
      total_owed: rec.totalOwed ?? null, owed_with_buffer: rec.owedWithBuffer ?? null,
      review_status: rec.reviewStatus || null, review_reason: rec.reviewReason || null,
      complaint_url: rec.complaintUrl || null, value_url: rec.valueUrl || null, docket_url: rec.docketUrl || null,
      filing_date: rec.filingDate || null, scan_month: MONTH, scan_year: YEAR, updated_at: new Date().toISOString(),
    }, { onConflict: 'case_number' });
  } catch (e) { log('upsert err', String(e.message).slice(0, 50)); }
}

// ---- Volusia front-half ----
// Weekly report URL for a given Saturday (week-ending). Reports are generated ~01:00 the following morning.
const rptUrl = d => `${RPT}/CI_${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}.html`;
// All week-ending Saturdays whose report can carry a filing date inside [FROM_D, TO_D]. Filings show up in the
// report for the week they were docketed (a Fri 6/19 filing lands in the 6/27 report), so we fetch a little wide
// and filter each row by its own filing date.
function saturdaysCovering(from, to) {
  const first = new Date(from); first.setDate(first.getDate() - 6);              // catch a filing reported the prior week
  while (first.getDay() !== 6) first.setDate(first.getDate() + 1);               // advance to Saturday
  const last = new Date(to); last.setDate(last.getDate() + 7);                   // catch a filing reported the next week
  const out = [];
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 7)) out.push(new Date(d));
  return out;
}
function cleanCell(html) { return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/[ \t]+/g, ' ').split('\n').map(x => x.trim()).filter(Boolean); }
function inWindow(mdy) { const m = mdy.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (!m) return false; const d = new Date(+m[3], +m[1] - 1, +m[2]); return d >= FROM_D && d <= TO_D; }
async function fetchWeek(d) {
  try {
    const r = await fetch(rptUrl(d), { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
    if (!r.ok) return [];
    const html = await r.text();
    const rows = html.split(/<TR>/i).slice(1);
    const out = [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map(m => m[1]);
      if (cells.length < 5) continue;
      const caseNumber = cleanCell(cells[0]).join(' ').trim();
      if (!/^\d{4}\s+\d+\s+[A-Z]{4}/.test(caseNumber)) continue;                 // "YYYY NNNNN XXXX"
      const plaintiffLines = cleanCell(cells[1]);
      const defendantLines = cleanCell(cells[2]);
      const filing = cleanCell(cells[4]).join(' ').trim();
      const plaintiff = (plaintiffLines[0] || '').slice(0, 90);                  // entity name = first line (before Attorney/address)
      const defendant = (defendantLines[0] || '').slice(0, 90);
      out.push({ caseNumber, plaintiff, defendant, filingMDY: filing, filingDate: filing.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, (_, m, dd, y) => `${y}-${pad(+m)}-${pad(+dd)}`) });
    }
    return out;
  } catch (e) { return []; }
}

// ccms helpers -------------------------------------------------------------
async function acceptDisclaimer(p) { await p.evaluate(() => { const a = [...document.querySelectorAll('a,button,input')].find(x => /^\s*accept\s*$/i.test((x.innerText || x.value || '').trim())); if (a) a.click(); }).catch(() => {}); }
// Search a case number → return the caseCM_detail href (or null).
async function findCaseDetail(p, caseNumber) {
  await p.goto(`${CCMS}/inquiry.aspx`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(HEADED ? 1500 : 1000);
  if (!(await p.$('#Content1_CaseNum'))) { await acceptDisclaimer(p); await sleep(1500); }
  const box = await p.$('#Content1_CaseNum');
  if (!box) { await acceptDisclaimer(p); await sleep(1500); }
  await p.fill('#Content1_CaseNum', caseNumber).catch(() => {});
  await sleep(400);
  await p.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => /^\s*submit\s*$/i.test((x.innerText || '').trim())); if (a) a.click(); });
  await sleep(HEADED ? 5000 : 4000);
  return await p.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => /caseCM_detail/i.test(x.getAttribute('href') || '')); return a ? a.getAttribute('href') : null; });
}
// On the docket tab, find the row whose Docket-Type cell matches `re` and return its viewDoc docid.
async function docIdForType(p, reSource) {
  return await p.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const tr = [...document.querySelectorAll('tr')].find(r => { const tds = [...r.querySelectorAll('td')]; return tds[2] && re.test(tds[2].innerText.trim()) && r.querySelector('a[onclick*="viewDoc" i]'); });
    const a = tr && tr.querySelector('a[onclick*="viewDoc" i]');
    const m = a && (a.getAttribute('onclick') || '').match(/viewDocNoQueryString\('([^']*)'/);
    return m ? m[1] : null;
  }, reSource);
}
// Open viewDocument.aspx for a docid; it redacts server-side then serves the PDF via load_Redact.aspx. Poll for it.
async function fetchDocByDocId(ctx, docid) {
  const viewer = await ctx.newPage();
  let buf = null;
  const grab = async (r) => { try { const ct = (r.headers()['content-type'] || '').toLowerCase(); if (/pdf|octet/.test(ct)) { const b = Buffer.from(await r.body()); if (b.slice(0, 5).toString('latin1') === '%PDF-' && (!buf || b.length > buf.length)) buf = b; } } catch (e) {} };
  viewer.on('response', grab);
  try {
    await viewer.goto(`${CCMS}/viewDocument.aspx?v1=${docid}&v2=&v3=`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 35 && !buf; i++) await sleep(2000);   // redaction usually finishes in <10s; wait up to 70s
  } finally { await viewer.close().catch(() => {}); }
  return buf;
}

console.log(`\n=== Volusia foreclosure scan (weekly report + ccms) — ${DATE_FROM} → ${DATE_TO} | ${HEADED ? 'HEADED' : 'headless'} ===\n`);
let saved = 0, knock = 0, review = 0;
const ctx = await Camoufox({ headless: !HEADED, user_data_dir: join(tmpdir(), `camou-volusia-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
p.on('dialog', d => d.accept().catch(() => {}));
try {
  // 1) LEAD LIST — pull every weekly report covering the window, filter rows to the filing-date window, dedupe.
  const sats = saturdaysCovering(FROM_D, TO_D);
  log(`fetching ${sats.length} weekly report(s): ${sats.map(d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`).join(', ')}`);
  const seen = new Set();
  let cases = [];
  for (const d of sats) {
    const rows = await fetchWeek(d);
    for (const r of rows) { if (inWindow(r.filingMDY) && !seen.has(r.caseNumber)) { seen.add(r.caseNumber); cases.push(r); } }
  }
  cases.sort((a, b) => a.filingDate.localeCompare(b.filingDate));
  log(`found ${cases.length} foreclosure filing(s) in window`);
  if (MAX_CASES) cases = cases.slice(0, MAX_CASES);

  // 2) accept the disclaimer once
  await p.goto(`${CCMS}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await acceptDisclaimer(p);
  await sleep(2500);

  // 3) per case: bank filter → open case → docket → Complaint + Worksheet(Value) → address + owed → upsert
  for (const c of cases) {
    const rec = { caseNumber: c.caseNumber, plaintiff: c.plaintiff, defendant: c.defendant, type: 'FORECLOSURE', filingDate: c.filingDate, reviewStatus: 'auto', reviewReason: null };
    try {
      const isHoa = dropPlaintiff.test(c.plaintiff) && !bankPlaintiff.test(c.plaintiff);
      const isGov = govPlaintiff.test(c.plaintiff);
      if (isHoa) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'hoa_plaintiff'; }
      else if (isGov) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'gov_plaintiff'; }
      else {
        const href = await findCaseDetail(p, c.caseNumber);
        if (!href) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'case_not_found'; }
        else {
          await p.goto(new URL(href, CCMS).href, { waitUntil: 'domcontentloaded', timeout: 40000 });
          await sleep(2500);
          rec.docketUrl = p.url();
          await p.getByText('Docket', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
          await sleep(HEADED ? 5000 : 4000);

          const cmpId = await docIdForType(p, 'complaint\\s*/\\s*petition to foreclose');
          if (cmpId) {
            const cmp = await fetchDocByDocId(ctx, cmpId);
            if (cmp) { const f = join(tmpdir(), `vol-c-${c.caseNumber.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, cmp); rec.propertyAddress = await addr(f); const fd = filingDatePdf(f); if (fd) rec.filingDate = fd; try { unlinkSync(f); } catch (e) {} rec.complaintUrl = await saveDocToStorage(sb, c.caseNumber, 'complaint', cmp) || null; }
          }
          await sleep(700);
          const valId = await docIdForType(p, '^\\s*worksheet\\s*$|value of real property');
          if (valId) {
            const val = await fetchDocByDocId(ctx, valId);
            if (val) { const f = join(tmpdir(), `vol-v-${c.caseNumber.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, val); const o = await owed(f); rec.principalDue = o.principalDue; rec.interestOwed = o.interestOwed; try { unlinkSync(f); } catch (e) {} rec.valueUrl = await saveDocToStorage(sb, c.caseNumber, 'value', val) || null; }
          }
          const o = (rec.principalDue || 0) + (rec.interestOwed || 0); rec.totalOwed = o || null; rec.owedWithBuffer = o ? o + 10000 : null;
          if (!rec.complaintUrl) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_complaint'; }
          else if (!rec.propertyAddress) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_address'; }
        }
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
  log(`\nVOLUSIA DONE | saved ${saved} | knock ${knock} | review ${review}`);
} catch (e) { log('FATAL', e.message); } finally { await ctx.close().catch(() => {}); }
process.exit(0);
