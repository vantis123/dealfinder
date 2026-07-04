// Polk County foreclosure scraper — Polk Records Online (PRO), the Clerk's consolidated CIVIL case search
// at https://pro.polkcountyclerk.net/PRO  (Polk's equivant ShowCase = showcase.polkcountyclerk.net is
// CRIMINAL/traffic only — NOT used here; civil foreclosures live only in PRO).
//
// Flow (mapped by sight, per visual-web-recon):
//   Public Access → reCAPTCHA v2 (solved via CapSolver, ProxyLess) → Public Search →
//   Court Type = Circuit Civil + UCN "<YEAR>CA" (partial, required) + Case Filing Date window → results
//   (#gridtable, set length 100) → open each Detail/CR-# → Case Type must be a mortgage FORECLOSURE
//   (RPMFH homestead / RPMFN non-homestead / RPMFC commercial) → read docket → download the COMPLAINT +
//   "VALUE OF REAL PROPERTY OR MORTGAGE FORECLOSURE CLAIM" PDFs → address + owed → upsert
//   foreclosure_leads (county='Polk'). Bank-only filter + shared back-half identical to Lake/Seminole/Orange.
//
// Doc download chain (all public, no registration): a docket row's view icon fires
//   OpenInNewWin('<docToken>','<seq>')  →  /PRO/DocViewer/SubmitIRequest/?id=<docToken>-<seq>
//   → 302 → /PRO/DocViewer/MakeRequest/...  (iframe#pdfSource src = /PRO/DocViewer/returnUrl/<suffix>)
//   → navigating that returnUrl streams the real PDF from /PRO/DocViewer/GetDoc/<suffix> (application/pdf).
//   Polk complaints are SCANNED IMAGES (no text layer) → the shared addrVision (Claude reads the PDF) is
//   the primary address path here, exactly like Lake.
//
// Run headed:  HEADED=1 node scripts/run-polk.mjs     Window: DAYS=N (default 3) or DATE_FROM/DATE_TO (ISO)
//   MAX_CASES=N caps FORECLOSURES processed (testing).  SKIP_VALUE=1 skips the Apify Zillow valuation pass.
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
const BASE = 'https://pro.polkcountyclerk.net';
const SITEKEY = '6LeRVRMTAAAAAEJVnKICULEC488zz4fqA3yocYVN';   // PRO PublicLogin reCAPTCHA v2 checkbox
const CAP = env.CAPSOLVER_API_KEY;
const HEADED = process.env.HEADED === '1';
const USE_AI = process.env.USE_AI !== '0';
const MAX_CASES = parseInt(process.env.MAX_CASES || '0', 10); // 0 = all foreclosures in window (testing cap)
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;   // PRO requires MM/DD/YYYY

// Bank-only filters (verbatim from run-lake — same intent as Seminole/Orange).
const dropPlaintiff = /\bassociation\b|\bassoc\b|\bH\.?\s?O\.?\s?A\b|homeowner|condominium|\bcondo\b|property\s+owners|townhom\w*/i;
const bankPlaintiff = /\bbank\b|national\s+association|\bN\.?\s?A\.?\b|mortgage|\bloan|\btrust\b|financ|federal|savings|servic|lender|credit\s+union|fargo|chase|citi|wells|fannie|freddie|rocket|nationstar|loandepot|carrington|newrez|freedom|villa?ge capital|wilmington/i;
const govPlaintiff = /^\s*polk county\b|\bcity of\b|\bstate of florida\b|tax collector|code enforcement|clerk of\b/i;
// Mortgage-foreclosure case types in PRO's Circuit-Civil division (from the case detail "Case Type"):
//   RPMFH = FORECLOSURE HOMESTEAD RESIDENTIAL, RPMFN = FORECLOSURE NON HOMESTEAD RESIDENT, RPMFC = commercial.
//   (RPMFO "OTHER REAL PROPERTY ACTIONS" is excluded — mostly HOA liens / quiet-title, not bank mortgages.)
const foreclosureType = /\bRPMF[HNC]\b|mortgage\s+foreclos/i;

const now = new Date();
const MONTH = now.getMonth() + 1, YEAR = now.getFullYear();
const isoToMDY = s => { const [Y, M, D] = s.split('-').map(Number); return `${pad(M)}/${pad(D)}/${Y}`; };
let DATE_FROM, DATE_TO;
if (process.env.DATE_FROM) { DATE_FROM = isoToMDY(process.env.DATE_FROM); DATE_TO = isoToMDY(process.env.DATE_TO || now.toISOString().slice(0, 10)); }
else { const days = parseInt(process.env.DAYS || '3', 10); const f = new Date(now); f.setDate(f.getDate() - days); DATE_FROM = fmt(f); DATE_TO = fmt(now); }
// UCN partial prefixes to search (PRO requires UCN/Citation/LastName). One per calendar year the window spans.
const YEARS = [...new Set([DATE_FROM.split('/')[2], DATE_TO.split('/')[2]])];

// ---- back-half (address + owed) — verbatim from run-lake ----
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
    let snip = ''; const re = /\[\s*property address\s*\]|located at/ig; let m, n = 0;
    while ((m = re.exec(raw)) && n < 2) { snip += raw.slice(Math.max(0, m.index - 1400), m.index + 250) + '\n…\n'; n++; }
    if (!snip) snip = raw.slice(0, 9000); snip = snip.replace(/[ \t]+/g, ' ').slice(0, 6000);
    const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: `Text from a Florida mortgage foreclosure complaint. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed (labeled "[Property Address]" or right after "located at"). NOT the lender/servicer/law-firm/agent address. Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.\n\n${snip}` }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return j.address && /\d/.test(j.address) ? String(j.address).replace(/\s{2,}/g, ' ').trim() : null;
  } catch (e) { return null; }
}
// Vision fallback — Polk complaints are scanned images (no text layer), so read the PDF directly.
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
async function owedOCR(file) { const tmp = join(tmpdir(), `polk-ocr-${process.pid}-${Math.random().toString(36).slice(2)}`); try { await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]); const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 5e7 }); const p = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Principal due/i), i = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest owed/i); return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null }; } catch (e) { return {}; } finally { try { unlinkSync(`${tmp}.png`); } catch (e) {} } }
async function owedAI(file) { try { const b64 = readFileSync(file).toString('base64'); const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only.' }] }] }); const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]); return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) }; } catch (e) { return {}; } }
async function owed(file) { const r = await owedOCR(file); if (r.principalDue != null || r.interestOwed != null) return r; return USE_AI ? owedAI(file) : r; }

async function upsertLead(rec) {
  try {
    await sb.from('foreclosure_leads').upsert({
      case_number: rec.caseNumber, county: 'Polk', plaintiff: rec.plaintiff || null, defendant: rec.defendant || null, type: rec.type || null,
      property_address: rec.propertyAddress || null, principal_due: rec.principalDue ?? null, interest_owed: rec.interestOwed ?? null,
      total_owed: rec.totalOwed ?? null, owed_with_buffer: rec.owedWithBuffer ?? null,
      review_status: rec.reviewStatus || null, review_reason: rec.reviewReason || null,
      complaint_url: rec.complaintUrl || null, value_url: rec.valueUrl || null, docket_url: rec.docketUrl || null,
      filing_date: rec.filingDate || null, scan_month: MONTH, scan_year: YEAR, updated_at: new Date().toISOString(),
    }, { onConflict: 'case_number' });
  } catch (e) { log('upsert err', String(e.message).slice(0, 50)); }
}

// ---- CapSolver reCAPTCHA v2 (ProxyLess) — same recipe as Orange's run-month ----
const post = async (u, b) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json(); };
async function solveToken() {
  for (let a = 1; a <= 4; a++) {
    try {
      const c = await post('https://api.capsolver.com/createTask', { clientKey: CAP, task: { type: 'ReCaptchaV2TaskProxyLess', websiteURL: BASE + '/PRO/Home/PublicLogin', websiteKey: SITEKEY } });
      if (c.errorId) throw new Error(c.errorDescription || 'create failed');
      for (let i = 0; i < 30 && c.taskId; i++) { await sleep(3000); const r = await post('https://api.capsolver.com/getTaskResult', { clientKey: CAP, taskId: c.taskId }); if (r.status === 'ready') return r.solution.gRecaptchaResponse; if (r.status === 'failed' || r.errorId) throw new Error(r.errorDescription || 'solve failed'); }
      throw new Error('timeout');
    } catch (e) { if (a === 4) throw e; await sleep(1500); }
  }
}

// ---- PRO front-half ----
// Get past the Public Access reCAPTCHA gate → land on the Public Search form.
async function publicLogin(page) {
  for (let attempt = 0; attempt < 4 && !(await page.$('#UCN')); attempt++) {
    if (!/PublicLogin/i.test(page.url())) { await page.goto(BASE + '/PRO/Home/PublicLogin', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(3000); }
    if (await page.$('#UCN')) break;
    log('solving reCAPTCHA…');
    const tok = await solveToken();
    await page.evaluate((t) => { let ta = document.getElementById('g-recaptcha-response'); if (!ta) { ta = document.createElement('textarea'); ta.id = 'g-recaptcha-response'; ta.name = 'g-recaptcha-response'; (document.querySelector('form') || document.body).appendChild(ta); } ta.value = t; }, tok);
    await sleep(500);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button,input[type=submit],a')].find(x => /proceed|continue|submit/i.test((x.innerText || x.value || '').trim())); if (b) b.click(); });
    await sleep(5000);
  }
  return !!(await page.$('#UCN'));
}

// Run one Circuit-Civil search (court type + UCN prefix + date window) → return the result rows in the DOM.
async function searchRows(page, ucn) {
  await page.evaluate(() => { const cc = document.getElementById('Circuit_Civil'); if (cc && !cc.checked) cc.click(); const others = ['County_Civil', 'Juvenile', 'Probate']; others.forEach(id => { const e = document.getElementById(id); if (e && e.checked) e.click(); }); });
  await page.fill('#UCN', ucn); await page.fill('#DateFrom', DATE_FROM); await page.fill('#DateTo', DATE_TO);
  await sleep(400);
  await page.evaluate(() => { const b = [...document.querySelectorAll('input[type=button],input[type=submit],button')].find(x => /find case/i.test((x.value || x.innerText || '').trim())); if (b) b.click(); });
  await page.waitForFunction(() => !!document.querySelector('#gridtable tbody tr') || /No records|no cases/i.test(document.body.innerText), { timeout: 25000 }).catch(() => {});
  await sleep(1500);
  await page.evaluate(() => { const s = document.querySelector('select[name="gridtable_length"]'); if (s) { s.value = '100'; s.dispatchEvent(new Event('change', { bubbles: true })); } });
  await sleep(2000);
  return page.evaluate(() => [...document.querySelectorAll('#gridtable tbody tr')].map(tr => { const td = [...tr.querySelectorAll('td')]; const a = tr.querySelector('a[href*="Detail"]'); return { caseNo: (td[0]?.innerText || '').trim(), filed: (td[3]?.innerText || '').trim(), href: a ? a.getAttribute('href') : null }; }).filter(r => r.href));
}

// Download a docket document PDF. Chain: SubmitIRequest → MakeRequest (iframe#pdfSource = returnUrl) →
// navigating returnUrl streams the real PDF from /DocViewer/GetDoc/<suffix> (captured off the wire).
let grabbedPdf = null;
async function downloadDoc(page, token, seq) {
  grabbedPdf = null;
  await page.goto(`${BASE}/PRO/DocViewer/SubmitIRequest/?id=${token}-${seq}`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(2200);
  const src = await page.evaluate(() => { const f = document.getElementById('pdfSource'); return f ? f.getAttribute('src') : null; });
  if (!src) return null;
  const abs = src.startsWith('http') ? src : BASE + src;
  await page.goto(abs, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 20 && !grabbedPdf; i++) await sleep(500);   // give GetDoc time to stream
  return grabbedPdf;
}

console.log(`\n=== Polk foreclosure scan (PRO) — ${DATE_FROM} → ${DATE_TO} | ${HEADED ? 'HEADED' : 'headless'} ===\n`);
if (!CAP) { console.error('CAPSOLVER_API_KEY missing — PRO requires solving the Public Access reCAPTCHA.'); process.exit(1); }
const ctx = await Camoufox({ headless: !HEADED, user_data_dir: join(tmpdir(), `camou-polk-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
p.on('dialog', d => d.accept().catch(() => {}));
// capture the streamed PDF (GetDoc) regardless of which page/frame requested it
const onResp = async r => { try { const ct = (r.headers()['content-type'] || '').toLowerCase(); if (/pdf|octet/.test(ct)) { const b = Buffer.from(await r.body()); if (b.slice(0, 5).toString('latin1') === '%PDF-') grabbedPdf = b; } } catch (e) {} };
p.on('response', onResp); ctx.on('page', pg => { pg.on('response', onResp); pg.on('dialog', d => d.accept().catch(() => {})); });
let saved = 0, knock = 0, review = 0, scanned = 0, foreclosures = 0;
try {
  log('opening PRO / Public Access…');
  await p.goto(BASE + '/PRO/Home/PublicLogin', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  if (!(await publicLogin(p))) throw new Error('could not pass reCAPTCHA / reach search form');
  log('search form ready');

  // Gather candidate Circuit-Civil rows across the window (one search per calendar year spanned).
  const seen = new Set(); const candidates = [];
  for (const y of YEARS) {
    const rows = await searchRows(p, `${y}CA`);
    log(`UCN ${y}CA → ${rows.length} Circuit-Civil row(s) in ${DATE_FROM}–${DATE_TO}`);
    for (const r of rows) { if (!seen.has(r.caseNo)) { seen.add(r.caseNo); candidates.push(r); } }
    await p.goto(BASE + '/PRO/PublicSearch/PublicSearch', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(1500);
  }
  log(`${candidates.length} unique Circuit-Civil case(s); opening each to find mortgage foreclosures…\n`);

  for (const cand of candidates) {
    if (MAX_CASES && foreclosures >= MAX_CASES) break;
    scanned++;
    try {
      await p.goto(BASE + cand.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(900);
      const info = await p.evaluate(() => { const t = document.body.innerText; return { ct: (t.match(/Case Type\s*:\s*([^\n]+)/) || [])[1] || '', cs: (t.match(/Case Style\s*:\s*([^\n]+)/) || [])[1] || '' }; });
      if (!foreclosureType.test(info.ct)) continue;   // not a mortgage foreclosure — skip silently
      foreclosures++;
      const [plaintiff, defendant] = info.cs.split(/\s+vs\.?\s+/i).map(s => (s || '').trim());
      const rec = { caseNumber: cand.caseNo, type: info.ct.trim(), plaintiff: plaintiff || null, defendant: defendant || null, filingDate: cand.filed ? cand.filed.split('/').reverse().map((v, i, a) => i === 0 ? a[0] : v).join('') : null, reviewStatus: 'auto', reviewReason: null, docketUrl: p.url() };
      // filingDate: results table gives MM/DD/YYYY → ISO
      if (cand.filed && /^\d{2}\/\d{2}\/\d{4}$/.test(cand.filed)) { const [M, D, Y] = cand.filed.split('/'); rec.filingDate = `${Y}-${M}-${D}`; }

      const isHoa = dropPlaintiff.test(rec.plaintiff || '') && !bankPlaintiff.test(rec.plaintiff || '');
      const isGov = govPlaintiff.test(rec.plaintiff || '');
      if (isHoa) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'hoa_plaintiff'; }
      else if (isGov) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'gov_plaintiff'; }
      else {
        // Grab all docket-row tokens in one read (OpenInNewWin('<token>','<seq>')). Tokens stay valid for
        // the whole session, so no detail re-loads are needed between downloads.
        const docs = await p.evaluate(() => {
          const tables = [...document.querySelectorAll('table')];
          for (const t of tables) { const head = (t.querySelector('tr')?.innerText || ''); if (!(/Action/.test(head) && /View/.test(head))) continue;
            return [...t.querySelectorAll('tbody tr')].map(tr => { const td = [...tr.querySelectorAll('td')]; const oc = td[td.length - 1].querySelector('[onclick]')?.getAttribute('onclick') || ''; const m = oc.match(/OpenInNewWin\('([^']+)','([^']+)'\)/); return { action: (td[1]?.innerText || '').trim(), token: m ? m[1] : null, seq: m ? m[2] : null }; }).filter(d => d.token);
          }
          return [];
        });
        const cmp = docs.find(d => /complaint/i.test(d.action));
        const lis = docs.find(d => /lis\s*pendens/i.test(d.action));
        const val = docs.find(d => /value of real property/i.test(d.action));
        // COMPLAINT → save to storage (deliverable). NOTE: some Polk complaints carry the note/mortgage as
        // confidential exhibits, so PUBLIC access is gated to page 1 only (returnUrl suffix "-J" vs "-A"
        // for fully-open docs) — page 1 has no street address. So the ADDRESS is taken from the Lis Pendens.
        let cmpFile = null;
        if (cmp) {
          const buf = await downloadDoc(p, cmp.token, cmp.seq);
          if (buf) { cmpFile = join(tmpdir(), `polk-c-${rec.caseNumber.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(cmpFile, buf); const fd = filingDatePdf(cmpFile); if (fd) rec.filingDate = fd; rec.complaintUrl = await saveDocToStorage(sb, rec.caseNumber, 'complaint', buf) || null; }
        }
        // ADDRESS: Lis Pendens is 1 page, always public, and (by FL law) carries the legal description +
        // "Also known as: <street address>" — the reliable, cheap address source. Fall back to the complaint.
        if (lis) {
          const buf = await downloadDoc(p, lis.token, lis.seq);
          if (buf) { const f = join(tmpdir(), `polk-l-${rec.caseNumber.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, buf); rec.propertyAddress = await addr(f); try { unlinkSync(f); } catch (e) {} }
        }
        if (!rec.propertyAddress && cmpFile) rec.propertyAddress = await addr(cmpFile);
        if (cmpFile) { try { unlinkSync(cmpFile); } catch (e) {} }
        // VALUE OF REAL PROPERTY → owed (principal/interest) + save to storage (deliverable).
        if (val) {
          const buf = await downloadDoc(p, val.token, val.seq);
          if (buf) { const f = join(tmpdir(), `polk-v-${rec.caseNumber.replace(/[^A-Za-z0-9]/g, '')}.pdf`); writeFileSync(f, buf); const o = await owed(f); rec.principalDue = o.principalDue; rec.interestOwed = o.interestOwed; try { unlinkSync(f); } catch (e) {} rec.valueUrl = await saveDocToStorage(sb, rec.caseNumber, 'value', buf) || null; }
        }
        const o = (rec.principalDue || 0) + (rec.interestOwed || 0); rec.totalOwed = o || null; rec.owedWithBuffer = o ? o + 10000 : null;
        if (!rec.complaintUrl) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_complaint'; }
        else if (!rec.propertyAddress) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_address'; }
      }
      await upsertLead(rec); saved++;
      if (rec.reviewStatus === 'manual_review') review++; else knock++;
      log(`  ${foreclosures}${MAX_CASES ? '/' + MAX_CASES : ''} ${rec.caseNumber} | ${rec.type.replace(/^RPMF.\s*-\s*/, '')} | ${rec.plaintiff || '?'} | ${rec.propertyAddress || rec.reviewReason || '?'} | owed ${rec.owedWithBuffer || '—'} | ${rec.reviewStatus}`);
      await sleep(500);
    } catch (e) { log('  case err', cand.caseNo, String(e.message).slice(0, 40)); }
  }
  log(`\nscanned ${scanned} circuit-civil case(s) → ${foreclosures} foreclosure(s)`);
  if (HEADED) { log('scan done — closing in 8s…'); await sleep(8000); }
  await ctx.close().catch(() => {});
  if (process.env.SKIP_VALUE !== '1') {
    log('valuation pass (Apify Zillow)…');
    try { execFileSync(process.execPath, [join(__dirname, 'value-with-apify.mjs')], { stdio: 'inherit', env: process.env }); } catch (e) { log('valuation failed', String(e.message).slice(0, 60)); }
  }
  log(`\nPOLK DONE | saved ${saved} | knock ${knock} | review ${review}`);
} catch (e) { log('FATAL', e.message); } finally { await ctx.close().catch(() => {}); }
process.exit(0);
