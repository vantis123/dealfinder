// Osceola County foreclosure scraper — Pioneer "Benchmark" court records (courts.osceolaclerk.com/BenchmarkWeb).
// Osceola is in the NINTH Judicial Circuit (same as Orange) but uses a DIFFERENT engine than Orange's myeclerk:
// Pioneer Technology Group "Benchmark" v2.9.x. Mapped by sight (visual-web-recon) 2026-07-04.
//
// FRONT-HALF (Osceola-specific), all anonymous — NO login, NO captcha needed on search:
//   1. GET  Home.aspx/Search              → grab __RequestVerificationToken + default courtTypes/caseTypes.
//   2. POST CourtCase.aspx/CaseSearch     → establishes a session "last search". Filtering by caseTypes is
//        ignored anonymously, BUT courtTypes IS honored → courtType 7 = CIRCUIT CIVIL (where bank "CA…MF"
//        mortgage foreclosures live; traffic/criminal are other court types). Results cap at 5000 party-rows,
//        so we search DAY-BY-DAY (circuit-civil-only ≈ <700 party rows/day) and never truncate.
//   3. GET  CourtCase.aspx/ExportResults  → CSV ("Name","PartyType","Case Number","Status",…) of that search.
//        Keep case numbers ending in " MF" (Mortgage/Residential Foreclosure); PLAINTIFF row = plaintiff name.
//   4. Per case: POST CaseSearch(type=CaseNumber) then GET RecentSearch?index=0 → a single hit auto-opens the
//        case Details page, which renders the docket. Each doc row: <a class="casedocketimage" id=<caseDocketID>
//        digest=<per-session token>>. To pull the actual PDF (the viewer's own JS recipe, from master bundle):
//          a. POST ImageAsync.aspx/GetPDFRequestGuid {cid, digest, redacted:'False'} → returns a guid
//          b. poll POST ImageAsync.aspx/GetPDFProgress {guid} until progress <= 0
//          c. GET  ImageAsync.aspx/GetPDF?guid=<guid>  → application/pdf (the real document)
// SHARED BACK-HALF (verbatim from run-lake.mjs): pdftext/addrAnchor/addrAI/addrVision (Complaint address, incl.
//   Claude-vision for scanned complaints — Osceola complaints have NO text layer), owedOCR/owedAI (Value form
//   principal/interest), bank-only filter, saveDocToStorage → foreclosure_leads (county='Osceola').
//
// Run headed:  HEADED=1 node scripts/run-osceola.mjs   Window: DAYS=N (default 3) or DATE_FROM/DATE_TO (ISO).
import { Camoufox } from 'camoufox-js';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
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
const BASE = 'https://courts.osceolaclerk.com/BenchmarkWeb';
const COURT_CIRCUIT_CIVIL = '7';   // Benchmark courtType id for CIRCUIT CIVIL (bank "CA…MF" foreclosures). Mapped 2026-07-04.
const HEADED = process.env.HEADED === '1';
const USE_AI = process.env.USE_AI !== '0';
const MAX_CASES = parseInt(process.env.MAX_CASES || '0', 10); // 0 = all in window (testing cap)
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };

// Bank-only filters (same intent/regexes as Lake/Seminole/Orange).
const dropPlaintiff = /\bassociation\b|\bassoc\b|\bH\.?\s?O\.?\s?A\b|homeowner|condominium|\bcondo\b|property\s+owners|townhom\w*/i;
const bankPlaintiff = /\bbank\b|national\s+association|\bN\.?\s?A\.?\b|mortgage|\bloan|\btrust\b|financ|federal|savings|servic|lender|credit\s+union|fargo|chase|citi|wells|fannie|freddie|rocket|nationstar|loandepot|carrington|newrez|freedom|villa?ge capital|wilmington|onity|selene|shellpoint|planet home|pennymac|mr\.?\s?cooper|specialized loan/i;
const govPlaintiff = /^\s*osceola county\b|\bcity of\b|\bstate of florida\b|tax collector|code enforcement|clerk of\b/i;

const now = new Date();
const MONTH = now.getMonth() + 1, YEAR = now.getFullYear();
const pad = n => String(n).padStart(2, '0');
// Benchmark wants M/D/YYYY (no leading zeros); verified against the site.
const mdy = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
// Build the inclusive list of days (as M/D/YYYY) spanning the window — one search per day keeps every
// circuit-civil export well under the 5000-row cap, so no window is ever truncated.
function windowDays() {
  let from, to;
  if (process.env.DATE_FROM) {
    const p = s => { const [Y, M, D] = s.split('-').map(Number); return new Date(Y, M - 1, D); };
    from = p(process.env.DATE_FROM);
    to = process.env.DATE_TO ? p(process.env.DATE_TO) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else {
    const days = parseInt(process.env.DAYS || '3', 10);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    from = new Date(to); from.setDate(from.getDate() - days);
  }
  const out = [];
  for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) out.push(mdy(new Date(d)));
  return { days: out, label: `${out[0]} → ${out[out.length - 1]}` };
}

// ---- back-half (address + owed) — VERBATIM from run-lake.mjs ----
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
// Vision fallback — Osceola complaints are scanned images (no text layer), so read the PDF directly.
// Osceola scans can be huge (25MB+); Anthropic caps a request at 32MB (~24MB raw PDF), so trim oversized
// complaints to their first pages before vision (the mortgaged-property address is always in Count I up front).
function trimPdf(file, pages = 15) {
  const base = join(tmpdir(), `osc-vis-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try { execFileSync('sh', ['-c', `pdfseparate -f 1 -l ${pages} "${file}" "${base}-%d.pdf" && pdfunite "${base}"-*.pdf "${base}.pdf"`], { timeout: 60000 }); execFileSync('sh', ['-c', `rm -f "${base}"-*.pdf`]); return `${base}.pdf`; } catch (e) { try { execFileSync('sh', ['-c', `rm -f "${base}"-*.pdf "${base}.pdf"`]); } catch (_) {} return null; }
}
async function addrVision(file) {
  let src = file, trimmed = null;
  try {
    if (statSync(file).size > 15 * 1024 * 1024) { const t = trimPdf(file); if (t) { src = t; trimmed = t; } }
    const b64 = readFileSync(src).toString('base64');
    const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida mortgage foreclosure complaint. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed (NOT the lender/servicer/law-firm/agent address). Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.' }] }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return j.address && /\d/.test(j.address) ? String(j.address).replace(/\s{2,}/g, ' ').trim() : null;
  } catch (e) { return null; } finally { if (trimmed) { try { unlinkSync(trimmed); } catch (e) {} } }
}
async function addr(file) {
  const raw = pdftext(file);
  const quick = addrAnchor(raw);
  if (quick) return quick;
  if (USE_AI && raw.replace(/\s/g, '').length > 300) { const a = await addrAI(raw); if (a) return a; } // has a text layer
  return USE_AI ? await addrVision(file) : null;                                                        // scanned image → read the PDF
}
async function owedOCR(file) { const tmp = join(tmpdir(), `osc-ocr-${process.pid}-${Math.random().toString(36).slice(2)}`); try { await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]); const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 5e7 }); const p = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Principal due/i), i = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest owed/i); return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null }; } catch (e) { return {}; } finally { try { unlinkSync(`${tmp}.png`); } catch (e) {} } }
async function owedAI(file) { try { const b64 = readFileSync(file).toString('base64'); const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only.' }] }] }); const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]); return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) }; } catch (e) { return {}; } }
async function owed(file) { const r = await owedOCR(file); if (r.principalDue != null || r.interestOwed != null) return r; return USE_AI ? owedAI(file) : r; }

async function upsertLead(rec) {
  try {
    await sb.from('foreclosure_leads').upsert({
      case_number: rec.caseNumber, county: 'Osceola', plaintiff: rec.plaintiff || null, defendant: rec.defendant || null, type: rec.type || null,
      property_address: rec.propertyAddress || null, principal_due: rec.principalDue ?? null, interest_owed: rec.interestOwed ?? null,
      total_owed: rec.totalOwed ?? null, owed_with_buffer: rec.owedWithBuffer ?? null,
      review_status: rec.reviewStatus || null, review_reason: rec.reviewReason || null,
      complaint_url: rec.complaintUrl || null, value_url: rec.valueUrl || null, docket_url: rec.docketUrl || null,
      filing_date: rec.filingDate || null, scan_month: MONTH, scan_year: YEAR, updated_at: new Date().toISOString(),
    }, { onConflict: 'case_number' });
  } catch (e) { log('upsert err', String(e.message).slice(0, 50)); }
}

// ---- Benchmark front-half ----
async function jpost(page, path, data) {   // ASP.NET PageMethod → { d: <result> }
  const r = await page.request.post(`${BASE}/${path}`, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' }, data: JSON.stringify(data), timeout: 60000 });
  const t = await r.text(); try { return JSON.parse(t).d; } catch (e) { return t; }
}
async function formPost(page, path, obj) {
  const r = await page.request.post(`${BASE}/${path}`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, data: new URLSearchParams(obj).toString(), timeout: 60000 });
  return await r.text();
}
// Run a search (populates the session "last search") then export it as CSV rows.
async function searchExport(page, tok, courtTypes, caseTypesDefault, { from, to, type = '', search = '' }) {
  await formPost(page, 'CourtCase.aspx/CaseSearch', { __RequestVerificationToken: tok, type, search, openedFrom: from || '', openedTo: to || '', closedFrom: '', closedTo: '', courtTypes, caseTypes: caseTypesDefault, partyTypes: '', divisions: '', statutes: '', partyBirthYear: '' });
  const r = await page.request.get(`${BASE}/CourtCase.aspx/ExportResults`, { timeout: 60000 });
  return await r.text();
}
// Parse the ExportResults CSV → { caseNumber: {plaintiff, defendant} }. Names are quoted (may contain commas).
function parseExport(csv) {
  const out = {};
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)","((?:[^"]|"")*)"/);
    if (!m) continue;
    const name = m[1].replace(/""/g, '"').trim(), ptype = m[2].trim().toUpperCase(), cn = m[3].trim();
    if (!cn || cn === 'Case Number') continue;
    const rec = out[cn] || (out[cn] = { plaintiff: null, defendant: null });
    if (/PLAINTIFF/.test(ptype) && !rec.plaintiff) rec.plaintiff = name;
    if (/DEFENDANT/.test(ptype) && !rec.defendant) rec.defendant = name;
  }
  return out;
}
// Open one case (unique case number → single hit auto-opens Details) and read its docket document rows.
async function openCase(page, tok, caseTypesDefault, caseNumber) {
  await formPost(page, 'CourtCase.aspx/CaseSearch', { __RequestVerificationToken: tok, type: 'CaseNumber', search: caseNumber, openedFrom: '', openedTo: '', closedFrom: '', closedTo: '', courtTypes: COURT_CIRCUIT_CIVIL, caseTypes: caseTypesDefault, partyTypes: '', divisions: '', statutes: '', partyBirthYear: '' });
  await page.goto(`${BASE}/CourtCase.aspx/RecentSearch?index=0`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('a.casedocketimage').length > 0 || /No records|not found/i.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  await sleep(1200);
  return await page.evaluate(() => {
    const docs = [...document.querySelectorAll('a.casedocketimage')].map(a => { const tr = a.closest('tr'); return { cid: a.id, digest: a.getAttribute('digest'), label: (tr ? tr.innerText : '').replace(/\s+/g, ' ').trim() }; });
    const parties = [...document.querySelectorAll('tr')].map(tr => tr.innerText.replace(/\s+/g, ' ').trim());
    const plRow = parties.find(t => /^PLAINTIFF\b/i.test(t));
    const caseType = (document.body.innerText.match(/Case Type:\s*([^\n]{3,80})/i) || [])[1] || null;
    return { docs, url: location.href, plaintiff: plRow ? plRow.replace(/^PLAINTIFF\s*/i, '').split(/\s{2,}| ATTORNEY| DEFENDANT/i)[0].trim().slice(0, 80) : null, caseType: caseType ? caseType.replace(/\s{2,}.*/, '').trim() : null };
  });
}
// Download a docket document as a real PDF via the ImageAsync GetPDFRequestGuid → poll → GetPDF recipe.
async function downloadDoc(page, cid, digest) {
  try {
    const guid = await jpost(page, 'ImageAsync.aspx/GetPDFRequestGuid', { cid: Number(cid), digest, time: new Date().toISOString(), redacted: 'False' });
    if (!guid || typeof guid !== 'string') return null;
    for (let i = 0; i < 50; i++) { const p = await jpost(page, 'ImageAsync.aspx/GetPDFProgress', { guid, time: new Date().toISOString() }); if (Number(p) <= 0) break; await sleep(600); }
    const r = await page.request.get(`${BASE}/ImageAsync.aspx/GetPDF?guid=${encodeURIComponent(guid)}`, { timeout: 90000 });
    const buf = Buffer.from(await r.body());
    return buf.slice(0, 5).toString('latin1') === '%PDF-' ? buf : null;
  } catch (e) { return null; }
}

const { days, label } = windowDays();
console.log(`\n=== Osceola foreclosure scan (Benchmark) — ${label} | circuit-civil MF | ${HEADED ? 'HEADED' : 'headless'} ===\n`);
const ctx = await Camoufox({ headless: !HEADED, user_data_dir: join(tmpdir(), `camou-osceola-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
p.on('dialog', d => d.accept().catch(() => {}));
let saved = 0, knock = 0, review = 0;
try {
  log('opening Benchmark search…');
  await p.goto(`${BASE}/Home.aspx/Search`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  const fv = await p.evaluate(() => { const g = n => document.querySelector(`[name="${n}"]`)?.value || ''; return { token: g('__RequestVerificationToken'), caseTypes: g('caseTypes') }; });
  if (!fv.token) throw new Error('no __RequestVerificationToken — page did not load');

  // 1) enumerate new MF (mortgage/residential foreclosure) filings across the window, day by day
  const cases = {};   // caseNumber → { plaintiff, defendant }
  for (const day of days) {
    const csv = await searchExport(p, fv.token, COURT_CIRCUIT_CIVIL, fv.caseTypes, { from: day, to: day });
    const parsed = parseExport(csv);
    let dayMf = 0;
    for (const [cn, rec] of Object.entries(parsed)) {
      if (cn.trim().split(/\s+/).pop() !== 'MF') continue;   // circuit-civil MF suffix = mortgage/residential foreclosure
      if (!cases[cn]) { cases[cn] = rec; dayMf++; }
    }
    log(`  ${day}: ${Object.keys(parsed).length} circuit-civil case(s) → +${dayMf} MF`);
    await sleep(400);
  }
  let list = Object.entries(cases).map(([caseNumber, r]) => ({ caseNumber, plaintiff: r.plaintiff, defendant: r.defendant }))
    .sort((a, b) => b.caseNumber.localeCompare(a.caseNumber));
  if (MAX_CASES) list = list.slice(0, MAX_CASES);
  log(`\nfound ${list.length} mortgage-foreclosure filing(s) in window\n`);

  // 2) per case → docket → Complaint + Value PDFs → address + owed → upsert
  for (const c of list) {
    const rec = { caseNumber: c.caseNumber, type: 'MORTGAGE/RESIDENTIAL FORECLOSURE', plaintiff: c.plaintiff, defendant: c.defendant, reviewStatus: 'auto', reviewReason: null };
    try {
      const isHoa = dropPlaintiff.test(c.plaintiff || '') && !bankPlaintiff.test(c.plaintiff || '');
      const isGov = govPlaintiff.test(c.plaintiff || '');
      if (isHoa) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'hoa_plaintiff'; }
      else if (isGov) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'gov_plaintiff'; }
      else {
        const info = await openCase(p, fv.token, fv.caseTypes, c.caseNumber);
        rec.docketUrl = info.url;
        if (info.plaintiff && !rec.plaintiff) rec.plaintiff = info.plaintiff;
        if (info.caseType) rec.type = info.caseType;
        const pick = re => info.docs.find(d => re.test(d.label));
        const cmpDoc = info.docs.filter(d => /complaint/i.test(d.label)).sort((a, b) => (/foreclos/i.test(b.label) ? 1 : 0) - (/foreclos/i.test(a.label) ? 1 : 0))[0];
        const valDoc = pick(/value of real property/i);
        if (cmpDoc) { const buf = await downloadDoc(p, cmpDoc.cid, cmpDoc.digest); if (buf) { const f = join(tmpdir(), `osc-c-${c.caseNumber.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, buf); rec.propertyAddress = await addr(f); rec.filingDate = filingDate(f); try { unlinkSync(f); } catch (e) {} rec.complaintUrl = await saveDocToStorage(sb, c.caseNumber, 'complaint', buf) || null; } }
        await sleep(500);
        if (valDoc) { const buf = await downloadDoc(p, valDoc.cid, valDoc.digest); if (buf) { const f = join(tmpdir(), `osc-v-${c.caseNumber.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, buf); const o = await owed(f); rec.principalDue = o.principalDue; rec.interestOwed = o.interestOwed; try { unlinkSync(f); } catch (e) {} rec.valueUrl = await saveDocToStorage(sb, c.caseNumber, 'value', buf) || null; } }
        const o = (rec.principalDue || 0) + (rec.interestOwed || 0); rec.totalOwed = o || null; rec.owedWithBuffer = o ? o + 10000 : null;
        if (!rec.complaintUrl) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_complaint'; }
        else if (!rec.propertyAddress) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_address'; }
      }
    } catch (e) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'err:' + String(e.message).slice(0, 20); }
    await upsertLead(rec); saved++;
    if (rec.reviewStatus === 'manual_review') review++; else knock++;
    log(`  ${saved}/${list.length} ${rec.caseNumber} | ${rec.plaintiff || '?'} | ${rec.propertyAddress || rec.reviewReason || '?'} | owed ${rec.owedWithBuffer || '—'} | ${rec.reviewStatus}`);
    await sleep(600);
  }
  if (HEADED) { log('\nscan done — closing in 8s…'); await sleep(8000); }
  await ctx.close().catch(() => {});
  if (process.env.SKIP_VALUE !== '1') {
    log('valuation pass (Apify Zillow)…');
    try { execFileSync(process.execPath, [join(__dirname, 'value-with-apify.mjs')], { stdio: 'inherit', env: process.env }); } catch (e) { log('valuation failed', String(e.message).slice(0, 60)); }
  }
  log(`\nOSCEOLA DONE | saved ${saved} | knock ${knock} | review ${review}`);
} catch (e) { log('FATAL', e.message); } finally { await ctx.close().catch(() => {}); }
process.exit(0);
