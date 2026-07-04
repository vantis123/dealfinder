// Brevard County foreclosure scraper — BECA (Brevard Electronic Court Application), a ColdFusion app at
// vmatrix1.brevardclerk.us/beca. Flow (mapped by sight, per visual-web-recon):
//   beca_splash.cfm → accept disclaimer (RadioChk=Yes + Submit) → StartSearch.cfm → General Public →
//   CaseType_Search.cfm: pick a FORECLOSURE case_type + begin_date/end_date → POST CaseType_Display.cfm →
//   results table (Date Filed | Case Number, each linking all_results.cfm?x=<token>) → open each case docket →
//   Participants (plaintiff/defendant + property address) + Register Of Actions (documents). The two docs we want:
//     Complaint  = "COMPLAINT OR PETITION"        (Viewable → get_document.cfm?doc_num=<GUID>)
//     Value      = "MORTGAGE CLAIM AMOUNT WORKSHEET" (Brevard's equivalent of the Value/Mortgage-Foreclosure-Claim
//                  form; Viewable on ~half of cases, "Pending" on freshly-filed ones — then owed stays null).
//   Docs are FULLY PUBLIC (no captcha) — the "Viewable" ones carry a get_document.cfm href that returns application/pdf.
//
// Shared BACK-HALF is copied verbatim from run-lake.mjs: pdftext/addrAnchor/addrAI/addrVision (address, incl.
// Claude-vision for scanned complaints), owedOCR/owedAI (principal/interest), bank-only filter, upsertLead →
// foreclosure_leads (county='Brevard'), saveDocToStorage, Apify Zillow valuation pass.
//
// Run headed:  HEADED=1 node scripts/run-brevard.mjs
// Window: DATE_FROM/DATE_TO (ISO) or DAYS=N (default 3). MAX_CASES caps total. SKIP_VALUE=1 skips the Apify pass.
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
const BASE = 'https://vmatrix1.brevardclerk.us/beca';
const HEADED = process.env.HEADED === '1';
const USE_AI = process.env.USE_AI !== '0';
const MAX_CASES = parseInt(process.env.MAX_CASES || '0', 10); // 0 = all in window
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;   // BECA wants MM/DD/YYYY

// Foreclosure case types that carry real-property bank mortgages (door-knock equity targets). County-court
// foreclosure liens (COUNTY REAL PROP*) are ~HOA and get filtered by plaintiff anyway; we sweep the circuit
// residential + commercial + generic real-property/mortgage types. Values in the <select> are space-padded, so
// we match by trimmed option text.
const FCL_TYPES = [
  'FCL-HOMESTEAD $0-$50000', 'FCL-HOMESTEAD $50001-$249999', 'FCL-HOMESTEAD $250000 & >',
  'FCL-NON-HOMESTEAD $0-$50000', 'FCL-NON-HOMESTD 50001-249999', 'FCL-NON-HOMESTEAD $250000 & >',
  'FCL-COMMERCIAL 0-$50000', 'FCL-COMMERCIAL $50001-249999', 'FCL-COMMERCIAL $250000 & >',
  'REAL PROPERTY/MORTGAGE FCL', 'REAL PROPERTY/MTG FORECLOSURE', 'OTHER REAL PROP/FORECLOSURE',
  'COUNTY REAL PROPERTY/MTG FCL', 'COUNTY REAL PROP FORECLOSURE',
];

// Bank-only filters (same intent/regex as Lake/Seminole).
const dropPlaintiff = /\bassociation\b|\bassoc\b|\bH\.?\s?O\.?\s?A\b|homeowner|condominium|\bcondo\b|property\s+owners|townhom\w*/i;
const bankPlaintiff = /\bbank\b|national\s+association|\bN\.?\s?A\.?\b|mortgage|\bloan|\btrust\b|financ|federal|savings|servic|lender|lending|credit\s+union|fargo|chase|citi|wells|fannie|freddie|rocket|nationstar|loandepot|carrington|newrez|freedom|villa?ge capital|wilmington/i;
const govPlaintiff = /^\s*brevard county\b|\bcity of\b|\bstate of florida\b|tax collector|code enforcement|clerk of\b/i;

const now = new Date();
const MONTH = now.getMonth() + 1, YEAR = now.getFullYear();
const isoToMDY = s => { const [Y, M, D] = s.split('-').map(Number); return `${pad(M)}/${pad(D)}/${Y}`; };
let DATE_FROM, DATE_TO;
if (process.env.DATE_FROM) { DATE_FROM = isoToMDY(process.env.DATE_FROM); DATE_TO = isoToMDY(process.env.DATE_TO || now.toISOString().slice(0, 10)); }
else { const days = parseInt(process.env.DAYS || '3', 10); const f = new Date(now); f.setDate(f.getDate() - days); DATE_FROM = fmt(f); DATE_TO = fmt(now); }

// ---- back-half (address + owed) — copied verbatim from run-lake.mjs ----
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
async function owedOCR(file) { const tmp = join(tmpdir(), `brev-ocr-${process.pid}-${Math.random().toString(36).slice(2)}`); try { await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]); const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 5e7 }); const p = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Principal due/i), i = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest owed/i); return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null }; } catch (e) { return {}; } finally { try { unlinkSync(`${tmp}.png`); } catch (e) {} } }
async function owedAI(file) { try { const b64 = readFileSync(file).toString('base64'); const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida "Mortgage Claim Amount Worksheet" / "Value of Real Property or Mortgage Foreclosure Claim" form. Return the principal balance due and the interest owed on the mortgage. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only, null if not present.' }] }] }); const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]); return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) }; } catch (e) { return {}; } }
async function owed(file) { const r = await owedOCR(file); if (r.principalDue != null || r.interestOwed != null) return r; return USE_AI ? owedAI(file) : r; }

async function upsertLead(rec) {
  try {
    await sb.from('foreclosure_leads').upsert({
      case_number: rec.caseNumber, county: 'Brevard', plaintiff: rec.plaintiff || null, defendant: rec.defendant || null, type: rec.type || null,
      property_address: rec.propertyAddress || null, principal_due: rec.principalDue ?? null, interest_owed: rec.interestOwed ?? null,
      total_owed: rec.totalOwed ?? null, owed_with_buffer: rec.owedWithBuffer ?? null,
      review_status: rec.reviewStatus || null, review_reason: rec.reviewReason || null,
      complaint_url: rec.complaintUrl || null, value_url: rec.valueUrl || null, docket_url: rec.docketUrl || null,
      filing_date: rec.filingDate || null, scan_month: MONTH, scan_year: YEAR, updated_at: new Date().toISOString(),
    }, { onConflict: 'case_number' });
  } catch (e) { log('upsert err', String(e.message).slice(0, 50)); }
}

// ---- BECA front-half ----
async function acceptDisclaimer(p) {
  await p.goto(`${BASE}/beca_splash.cfm`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  await p.evaluate(() => { const r = document.querySelector('input[name=RadioChk][value=Yes]'); if (r) r.checked = true; const s = document.querySelector('input[name=Submit]'); if (s) s.click(); });
  await sleep(2500);
}
// Run one case-type search; return [{num, dateFiled, href}] from the results table.
async function searchType(p, ct) {
  await p.goto(`${BASE}/CaseType_Search.cfm`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(HEADED ? 800 : 400);
  const ok = await p.evaluate(({ ct, df, dt }) => {
    const s = document.querySelector('select[name=case_type]'); if (!s) return false;
    const o = [...s.options].find(o => o.text.trim() === ct); if (!o) return false;
    s.value = o.value;
    document.querySelector('input[name=begin_date]').value = df;
    document.querySelector('input[name=end_date]').value = dt;
    document.querySelector('input[name=submit]').click();
    return true;
  }, { ct, df: DATE_FROM, dt: DATE_TO });
  if (!ok) return [];
  await sleep(HEADED ? 3500 : 2600);
  return await p.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="all_results.cfm"]')) {
      const num = (a.innerText || '').trim(); if (!/\d{4}-CA-|\d{4}-CC-/i.test(num)) continue;
      const tr = a.closest('tr'); const tds = tr ? [...tr.querySelectorAll('td')].map(x => x.innerText.trim()) : [];
      const dateFiled = (tds.find(x => /^\d{2}\/\d{2}\/\d{4}$/.test(x)) || '');
      out.push({ num, dateFiled, href: a.href });
    }
    return out;
  });
}
// Parse a case docket: parties + case-info + the two document hrefs (fresh, session-bound get_document tokens).
async function readDocket(p, href) {
  await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => /Case Information/i.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  await sleep(HEADED ? 1500 : 800);
  return await p.evaluate(() => {
    const rowText = tr => (tr.innerText || '').replace(/\s+/g, ' ').trim();
    // Participants
    const partRows = [...document.querySelectorAll('tr')].filter(r => /^(PLAINTIFF|DEFENDANT|ATTORNEY)/i.test(rowText(r)));
    const cellsOf = tr => [...tr.querySelectorAll('td')].map(c => c.innerText.replace(/\s+/g, ' ').trim());
    let plaintiff = null, defendant = null, defAddr = null;
    for (const r of partRows) {
      const c = cellsOf(r); const type = (c[0] || '');
      if (/PLAINTIFF/i.test(type) && !plaintiff) plaintiff = (c[1] || '').slice(0, 90);
      if (/DEFENDANT/i.test(type) && !defendant && !/UNKNOWN (TENANT|SPOUSE|PARTY|HEIRS)/i.test(c[1] || '')) {
        defendant = (c[1] || '').slice(0, 90);
        // Participants columns: Type|Name|ParticipantId|DL|Race|Gender|DOB|Address1|Address2|City State Zip
        const street = c[7] || ''; const csz = c[9] || c[8] || '';
        if (/\d/.test(street) && /FL/i.test(csz)) defAddr = `${street}, ${csz}`.replace(/\s{2,}/g, ' ').trim();
      }
    }
    // Case information table
    const ciRow = [...document.querySelectorAll('tr')].find(r => /ORIGINAL|PENDING|CLOSED|DISPOSED/i.test(rowText(r)) && /CA-|CC-/i.test(rowText(r)));
    let type = null, fdate = null;
    if (ciRow) { const c = cellsOf(ciRow); type = (c[1] || '').trim() || null; const md = (c[2] || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (md) fdate = `${md[3]}-${String(+md[1]).padStart(2, '0')}-${String(+md[2]).padStart(2, '0')}`; }
    // Documents (Register Of Actions): find "Viewable" get_document.cfm hrefs by description
    const docHref = re => { const rows = [...document.querySelectorAll('tr')]; const r = rows.find(x => re.test(x.innerText || '')); if (!r) return null; const a = r.querySelector('a[href*="get_document"]'); return a ? a.href : null; };
    return {
      plaintiff, defendant, defAddr, type, filingDate: fdate,
      complaint: docHref(/COMPLAINT OR PETITION|\bCOMPLAINT\b/i),
      value: docHref(/MORTGAGE CLAIM AMOUNT WORKSHEET|VALUE OF REAL PROPERTY|MORTGAGE FORECLOSURE CLAIM/i),
    };
  });
}
async function fetchPdf(p, url) {
  try { const r = await p.request.get(url, { timeout: 60000 }); const b = Buffer.from(await r.body()); return b.slice(0, 5).toString('latin1') === '%PDF-' ? b : null; } catch (e) { return null; }
}

console.log(`\n=== Brevard foreclosure scan (BECA) — ${DATE_FROM} → ${DATE_TO} | ${HEADED ? 'HEADED' : 'headless'} ===\n`);
const ctx = await Camoufox({ headless: !HEADED, user_data_dir: join(tmpdir(), `camou-brevard-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
p.on('dialog', d => d.accept().catch(() => {}));
let saved = 0, knock = 0, review = 0;
try {
  log('opening BECA, accepting disclaimer…');
  await acceptDisclaimer(p);

  // Collect foreclosure cases across all FCL case types in the window.
  const seen = new Set(); let cases = [];
  for (const ct of FCL_TYPES) {
    const rows = await searchType(p, ct);
    for (const r of rows) { if (!seen.has(r.num)) { seen.add(r.num); cases.push({ ...r, ctype: ct }); } }
    log(`  ${ct}: ${rows.length} row(s)`);
    if (MAX_CASES && cases.length >= MAX_CASES) break;
  }
  if (MAX_CASES) cases = cases.slice(0, MAX_CASES);
  log(`\nfound ${cases.length} foreclosure case(s) in window\n`);

  for (const c of cases) {
    const rec = { caseNumber: c.num, type: c.ctype, reviewStatus: 'auto', reviewReason: null };
    try {
      const d = await readDocket(p, c.href);
      rec.plaintiff = d.plaintiff; rec.defendant = d.defendant; rec.type = d.type || c.ctype; rec.docketUrl = c.href;
      // filing date: prefer results-row date, else case-info date
      if (c.dateFiled && /^\d{2}\/\d{2}\/\d{4}$/.test(c.dateFiled)) { const [M, D, Y] = c.dateFiled.split('/'); rec.filingDate = `${Y}-${M}-${D}`; }
      else rec.filingDate = d.filingDate || null;

      const isHoa = dropPlaintiff.test(d.plaintiff || '') && !bankPlaintiff.test(d.plaintiff || '');
      const isGov = govPlaintiff.test(d.plaintiff || '');
      if (isHoa) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'hoa_plaintiff'; }
      else if (isGov) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'gov_plaintiff'; }
      else {
        if (d.complaint) {
          const buf = await fetchPdf(p, d.complaint);
          if (buf) { const f = join(tmpdir(), `brev-c-${c.num.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, buf); rec.propertyAddress = await addr(f); if (!rec.filingDate) rec.filingDate = filingDate(f); try { unlinkSync(f); } catch (e) {} rec.complaintUrl = await saveDocToStorage(sb, c.num, 'complaint', buf) || null; }
        }
        await sleep(400);
        if (d.value) {
          const buf = await fetchPdf(p, d.value);
          if (buf) { const f = join(tmpdir(), `brev-v-${c.num.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, buf); const o = await owed(f); rec.principalDue = o.principalDue; rec.interestOwed = o.interestOwed; try { unlinkSync(f); } catch (e) {} rec.valueUrl = await saveDocToStorage(sb, c.num, 'value', buf) || null; }
        }
        // fallback: defendant participant address if the complaint yielded nothing
        if (!rec.propertyAddress && d.defAddr && /\d/.test(d.defAddr)) rec.propertyAddress = d.defAddr;
        const o = (rec.principalDue || 0) + (rec.interestOwed || 0); rec.totalOwed = o || null; rec.owedWithBuffer = o ? o + 10000 : null;
        if (!rec.complaintUrl) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_complaint'; }
        else if (!rec.propertyAddress) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_address'; }
      }
    } catch (e) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'err:' + String(e.message).slice(0, 20); }
    await upsertLead(rec); saved++;
    if (rec.reviewStatus === 'manual_review') review++; else knock++;
    log(`  ${saved}/${cases.length} ${rec.caseNumber} | ${rec.plaintiff || '?'} | ${rec.propertyAddress || rec.reviewReason || '?'} | owed ${rec.owedWithBuffer || '—'} | ${rec.reviewStatus}`);
    await sleep(500);
  }
  if (HEADED) { log('\nscan done — closing in 8s…'); await sleep(8000); }
  await ctx.close().catch(() => {});
  if (process.env.SKIP_VALUE !== '1') {
    log('valuation pass (Apify Zillow)…');
    try { execFileSync(process.execPath, [join(__dirname, 'value-with-apify.mjs')], { stdio: 'inherit', env: { ...process.env, COUNTY: 'Brevard' } }); } catch (e) { log('valuation failed', String(e.message).slice(0, 60)); }
  }
  log(`\nBREVARD DONE | saved ${saved} | knock ${knock} | review ${review}`);
} catch (e) { log('FATAL', e.message); } finally { await ctx.close().catch(() => {}); }
process.exit(0);
