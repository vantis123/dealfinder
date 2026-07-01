// Seminole County foreclosure scraper (ASP.NET site). Mirrors run-month.mjs's Orange flow but for
// courtrecords.seminoleclerk.org: disclaimer → search 14H/14N → results → docket → CMPL+VALU PDFs via
// the doc_view2 → getPDFImage recipe → address + owed → upsert to foreclosure_leads (county='Seminole').
// Saves EVERY case (HOA / missing-doc ones marked manual_review). Apify valuation runs after, same as Orange.
//
// Run headed (watch it):   HEADED=1 node scripts/run-seminole.mjs
// Run headless (prod/cron): node scripts/run-seminole.mjs
// Window: DAYS=N (rolling, default) — daily.mjs passes DAYS; or SCAN_MONTH/SCAN_YEAR for a full month.
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
import { COUNTIES } from './counties.mjs';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const env = loadEnv(ROOT);
const BASE = 'https://courtrecords.seminoleclerk.org/civil/';
const CFG = COUNTIES.Seminole;
const HEADED = process.env.HEADED === '1';
const USE_AI = process.env.USE_AI !== '0'; // Claude fallback for scrambled Value forms (on by default)
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pace = ms => HEADED ? sleep(ms) : sleep(Math.min(ms, 300)); // slow + visible when headed
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const fmt = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

// Date window: rolling DAYS (default 3) OR an explicit month.
const now = new Date();
const MONTH = parseInt(process.env.SCAN_MONTH || String(now.getMonth() + 1), 10);
const YEAR = parseInt(process.env.SCAN_YEAR || String(now.getFullYear()), 10);
const isoToMDY = s => { const [Y, M, D] = s.split('-').map(Number); return `${M}/${D}/${Y}`; };
let DATE_FROM, DATE_TO;
if (process.env.DATE_FROM) { DATE_FROM = isoToMDY(process.env.DATE_FROM); DATE_TO = isoToMDY(process.env.DATE_TO || now.toISOString().slice(0, 10)); }
else if (process.env.SCAN_MONTH) { DATE_FROM = fmt(new Date(YEAR, MONTH - 1, 1)); DATE_TO = fmt(new Date(YEAR, MONTH, 0)); }
else { const days = parseInt(process.env.DAYS || '3', 10); const f = new Date(now); f.setDate(f.getDate() - days); DATE_FROM = fmt(f); DATE_TO = fmt(now); }

// ---- extraction (same back-half as Orange) ----
// Address: try a STRICT "[Property Address]" anchor (clean Fannie/Freddie mortgages); validate it; and if
// it's missing/garbled (template placeholders, missing street, or a servicer address), let Claude read it.
function pdftext(file) { try { return execFileSync('pdftotext', [file, '-'], { maxBuffer: 2e8 }).toString(); } catch (e) { return ''; } }
// Court filing date from the complaint's "E-Filed MM/DD/YYYY" stamp (first page) → ISO YYYY-MM-DD.
function filingDate(file) { try { const t = execFileSync('pdftotext', ['-l', '1', file, '-'], { maxBuffer: 5e7 }).toString(); const m = t.match(/E-?Filed:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i) || t.match(/\bFiled:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i); return m ? `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : null; } catch (e) { return null; } }
function isCleanAddr(s) { return !!s && /^\d/.test(s) && !/[\[\]{}]/.test(s) && /\bFL(?:ORIDA)?\b\s*\d{5}/i.test(s) && !/described|security instrument|lender|servic/i.test(s); }
function addrAnchor(raw) {
  const lines = raw.split('\n').map(l => l.replace(/\s{2,}/g, ' ').trim());
  for (let i = 0; i < lines.length; i++) {
    if (/\[\s*property address\s*\]/i.test(lines[i])) {
      const prev = [];
      for (let j = i - 1; j >= 0 && prev.length < 4; j--) {
        const ln = lines[j];
        if (!ln || /^[\[(].*[\])]$/.test(ln) || /described in the|security instrument|^lender|note dated/i.test(ln)) continue; // skip [City]/[State] placeholders + boilerplate
        prev.unshift(ln);
      }
      const ci = prev.findIndex(l => /\bFL\b\s*\d{5}|Florida\s*\d{5}/i.test(l));
      if (ci >= 0) {
        const street = ci > 0 ? prev[ci - 1] : '';
        const out = `${street ? street + ', ' : ''}${prev[ci]}`.replace(/\s*,\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
        if (isCleanAddr(out)) return out;
      }
    }
  }
  return null;
}
// Claude reads the MORTGAGED-property address (ignores lender/servicer/law-firm/agent addresses). Cheap (Haiku).
async function addrAI(raw) {
  try {
    let snip = '';
    const re = /\[\s*property address\s*\]|located at/ig; let m, n = 0;
    while ((m = re.exec(raw)) && n < 2) { snip += raw.slice(Math.max(0, m.index - 1400), m.index + 250) + '\n…\n'; n++; }
    if (!snip) snip = raw.slice(0, 9000);
    snip = snip.replace(/[ \t]+/g, ' ').slice(0, 6000);
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 120,
      messages: [{ role: 'user', content: `Text from a Florida mortgage foreclosure complaint. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed (the one labeled "[Property Address]" or right after "located at"). Do NOT return the lender, loan servicer, law firm, or registered-agent address. Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.\n\n${snip}` }],
    });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return j.address && /\d/.test(j.address) ? String(j.address).replace(/\s{2,}/g, ' ').trim() : null;
  } catch (e) { return null; }
}
async function addr(file) {
  const raw = pdftext(file);
  const quick = addrAnchor(raw);
  if (quick) return quick;                 // clean anchor hit → trust it (cheap)
  return USE_AI ? await addrAI(raw) : null; // garbled/servicer/missing → Claude reads it
}
async function owedOCR(file) {
  const tmp = join(tmpdir(), `sem-ocr-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]);
    const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 5e7 });
    const p = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Principal due/i), i = stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest owed/i);
    return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null };
  } catch (e) { return {}; } finally { try { unlinkSync(`${tmp}.png`); } catch (e) {} }
}
async function owedAI(file) { try { const b64 = readFileSync(file).toString('base64'); const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only.' }] }] }); const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]); return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) }; } catch (e) { return {}; } }
async function owed(file) { const r = await owedOCR(file); if (r.principalDue != null || r.interestOwed != null) return r; return USE_AI ? owedAI(file) : r; }

// Pull a docket PDF exactly how the viewer's JS does it.
async function fetchDoc(p, href) {
  try {
    const html = await (await p.request.get(new URL(href, BASE).href, { timeout: 30000 })).text();
    const m = html.match(CFG.docFetch.idVar); if (!m) return null;
    const r = await p.request.get(`${BASE}${CFG.docFetch.service}?id=${encodeURIComponent(JSON.stringify(m[1]))}`,
      { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 60000 });
    const buf = Buffer.from(JSON.parse(await r.text())[CFG.docFetch.responseKey], 'base64');
    return buf.slice(0, 5).toString('latin1') === '%PDF-' ? buf : null;
  } catch (e) { return null; }
}

async function upsertLead(rec) {
  try {
    await sb.from('foreclosure_leads').upsert({
      case_number: rec.caseNumber, county: 'Seminole',
      plaintiff: rec.plaintiff || null, defendant: rec.defendant || null, type: rec.type || null,
      property_address: rec.propertyAddress || null,
      principal_due: rec.principalDue ?? null, interest_owed: rec.interestOwed ?? null,
      total_owed: rec.totalOwed ?? null, owed_with_buffer: rec.owedWithBuffer ?? null,
      review_status: rec.reviewStatus || null, review_reason: rec.reviewReason || null,
      complaint_url: rec.complaintUrl || null, value_url: rec.valueUrl || null, docket_url: rec.docketUrl || null,
      filing_date: rec.filingDate || null,
      scan_month: MONTH, scan_year: YEAR, updated_at: new Date().toISOString(),
    }, { onConflict: 'case_number' });
  } catch (e) { log('supabase upsert err', String(e.message).slice(0, 50)); }
}

// ---- live progress for the dashboard (scan-status.json) ----
const STATUS = join(ROOT, 'scan-status.json');
const recent = [];
const tStart = Date.now();
const setStatus = o => { try { writeFileSync(STATUS, JSON.stringify({ county: 'Seminole', month: MONTH, year: YEAR, from: DATE_FROM, to: DATE_TO, mode: USE_AI ? 'ai' : 'ocr', ...o }, null, 2)); } catch (e) {} };

// ---- run ----
console.log(`\n=== Seminole foreclosure scan — ${DATE_FROM} → ${DATE_TO} | ${CFG.doorKnockCodes.join('+')} | ${HEADED ? 'HEADED' : 'headless'} ===\n`);
const ctx = await Camoufox({ headless: !HEADED, user_data_dir: join(tmpdir(), `camou-seminole-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
let saved = 0, knock = 0, review = 0;
const startedAt = new Date().toISOString();
setStatus({ running: true, done: 0, total: 0, startedAt, recent: [] });
try {
  log('opening search…');
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pace(2500);
  const agree = p.locator(`${CFG.disclaimer.container} >> text=${CFG.disclaimer.acceptText}`).first();
  if (await agree.count().catch(() => 0)) { log('accepting disclaimer…'); await agree.click().catch(() => {}); await pace(1500); }

  log(`date filter ${DATE_FROM} → ${DATE_TO}`);
  await p.fill(CFG.form.dateFrom, ''); await p.type(CFG.form.dateFrom, DATE_FROM, { delay: HEADED ? 70 : 0 });
  await p.fill(CFG.form.dateTo, ''); await p.type(CFG.form.dateTo, DATE_TO, { delay: HEADED ? 70 : 0 });
  await pace(700);
  // Select foreclosure case types in BOTH court groups (County 19L/20L + Circuit 14H/14N) before one search.
  // Use a direct JS click to open each dropdown (an overlapping panel link blocks Playwright's normal click),
  // force-check the options, and press Escape to close so the open menu doesn't cover the next dropdown.
  for (const g of CFG.caseTypeGroups) {
    const group = p.locator(`.multiselect-native-select:has(${g.select})`);
    log(`opening the ${g.label} case-type selector…`);
    await group.locator('button.multiselect').evaluate(el => el.click());
    await pace(900);
    for (const code of g.codes) {
      log(`  choosing ${code} (${CFG.foreclosureCodes[code]})…`);
      const box = group.locator(`.multiselect-container input[value="${code}"]`);
      await box.scrollIntoViewIfNeeded().catch(() => {});
      await box.check({ force: true }).catch(async () => { await box.evaluate(el => { if (!el.checked) el.click(); }).catch(() => {}); });
      await pace(500);
    }
    await group.locator('button.multiselect').evaluate(el => el.click()).catch(() => {}); // toggle dropdown closed
    await pace(700);
  }
  await pace(1500); // human pause → NoBot passes
  log('running the search…');
  await p.click(CFG.form.submit, { force: true }); // force past any leftover dropdown overlay
  await pace(4500);

  const cases = await p.evaluate(() => [...document.querySelectorAll('#CaseGrid tbody tr')]
    .map(r => { const a = r.querySelector('a[href*="civil_details"]'); const tds = [...r.querySelectorAll('td')].map(c => c.textContent.trim()); return a ? { num: a.textContent.trim(), href: a.getAttribute('href'), row: tds.join(' | ') } : null; })
    .filter(Boolean));
  log(`found ${cases.length} case(s)\n`);
  setStatus({ running: true, done: 0, total: cases.length, startedAt, recent: [] });

  for (const c of cases) {
    if (p.isClosed()) { log('browser window closed — stopping (remaining cases left for next run)'); break; }
    const rec = { caseNumber: c.num, reviewStatus: 'auto', reviewReason: null };
    try {
      const detail = new URL(c.href, BASE).href;
      await p.goto(detail, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pace(1800);
      rec.docketUrl = detail;
      const d = await p.evaluate(() => {
        const rows = [...document.querySelectorAll('#PartyGrid tbody tr')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
        const plaintiff = (rows.find(t => /PLAINTIFF/i.test(t)) || '').replace(/PLAINTIFF.*/i, '').trim().slice(0, 80);
        const defendant = (rows.find(t => /DEFENDANT/i.test(t)) || '').replace(/DEFENDANT.*/i, '').trim().slice(0, 80);
        const pick = code => { const r = [...document.querySelectorAll('#docketGrid tbody tr')].find(tr => new RegExp('\\b' + code + '\\b').test(tr.textContent)); const a = r?.querySelector('a[href*="doc_view2"]'); return a ? new URL(a.getAttribute('href'), location.href).href : null; };
        return { plaintiff, defendant, complaint: pick('CMPL'), value: pick('VALU') };
      });
      rec.plaintiff = d.plaintiff; rec.defendant = d.defendant;
      rec.complaintUrl = d.complaint; rec.valueUrl = d.value;

      // Filter: HOA plaintiff (check PLAINTIFF only) → review. A bank/lender name (e.g. "...NATIONAL
      // ASSOCIATION") is never an HOA, so the bank pattern overrides the HOA match. Missing either doc → review.
      const isHoa = CFG.dropPlaintiff.test(d.plaintiff) && !CFG.bankPlaintiff.test(d.plaintiff);
      const isGov = CFG.govPlaintiff?.test(d.plaintiff);
      if (isHoa) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'hoa_plaintiff'; }
      else if (isGov) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'gov_plaintiff'; }
      else if (!d.complaint || !d.value) { rec.reviewStatus = 'manual_review'; rec.reviewReason = !d.complaint ? 'no_complaint' : 'no_value'; }
      else {
        // Download → extract → SAVE the PDF to Supabase Storage (the doc_view2 token is session-bound), store
        // the permanent URL; fall back to the viewer link only if the upload fails.
        const cmp = await fetchDoc(p, d.complaint);
        if (cmp) { const f = join(tmpdir(), `sem-c-${c.num}.pdf`); writeFileSync(f, cmp); rec.propertyAddress = await addr(f); rec.filingDate = filingDate(f); try { unlinkSync(f); } catch (e) {} rec.complaintUrl = await saveDocToStorage(sb, c.num, 'complaint', cmp) || d.complaint; }
        const val = await fetchDoc(p, d.value);
        if (val) { const f = join(tmpdir(), `sem-v-${c.num}.pdf`); writeFileSync(f, val); const o = await owed(f); rec.principalDue = o.principalDue; rec.interestOwed = o.interestOwed; try { unlinkSync(f); } catch (e) {} rec.valueUrl = await saveDocToStorage(sb, c.num, 'value', val) || d.value; }
        const o = (rec.principalDue || 0) + (rec.interestOwed || 0); rec.totalOwed = o || null; rec.owedWithBuffer = o ? o + 10000 : null;
        if (!rec.propertyAddress) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'no_address'; }
      }
    } catch (e) { rec.reviewStatus = 'manual_review'; rec.reviewReason = 'err:' + String(e.message).slice(0, 20); }

    await upsertLead(rec); saved++;
    if (rec.reviewStatus === 'manual_review') review++; else knock++;
    recent.unshift({ caseNumber: rec.caseNumber, address: rec.propertyAddress || null, spread: null, flagged: false, x: rec.reviewStatus === 'manual_review' });
    if (recent.length > 12) recent.pop();
    setStatus({ running: true, done: saved, total: cases.length, knock, review, startedAt, recent: recent.slice(0, 12) });
    log(`  ${saved}/${cases.length} ${rec.caseNumber} | ${rec.plaintiff || '?'} | ${rec.propertyAddress || rec.reviewReason || '?'} | owed ${rec.owedWithBuffer || '—'} | ${rec.reviewStatus}`);
  }
  if (HEADED) { log('\nscan done — closing window in 10s…'); await sleep(10000); }
  await ctx.close().catch(() => {}); // free the browser before the valuation subprocess

  // Valuation: Zillow via Apify → spread/flagged (same back-half as Orange), then compute the scan summary.
  log('valuation pass (Apify Zillow)…');
  setStatus({ running: true, done: saved, total: cases.length, knock, review, startedAt, recent: recent.slice(0, 12) });
  try { execFileSync(process.execPath, [join(__dirname, 'value-with-apify.mjs')], { stdio: 'inherit', env: process.env }); }
  catch (e) { log('valuation step failed', String(e.message).slice(0, 60)); }

  // Scan summary for the dashboard overlay — read back from Supabase for THIS county+month.
  let nKnock = 0, nReview = 0, nNotWorth = 0, pipeline = 0;
  try {
    const since = new Date(tStart).toISOString(); // only this run's leads
    const { data } = await sb.from('foreclosure_leads').select('flagged, review_status, spread')
      .eq('county', 'Seminole').gte('updated_at', since);
    for (const r of data || []) {
      if (r.flagged) { nKnock++; pipeline += Number(r.spread) || 0; }
      else if (r.review_status === 'manual_review') nReview++;
      else nNotWorth++;
    }
  } catch (e) {}
  const mins = ((Date.now() - tStart) / 60000).toFixed(1);
  setStatus({ running: false, done: saved, total: cases.length, knock: nKnock, review: nReview, notWorth: nNotWorth, pipelineAdded: pipeline, recent: recent.slice(0, 12), minutes: Number(mins), finishedAt: new Date().toISOString() });
  log(`\nSEMINOLE DONE | saved ${saved} | KNOCK ${nKnock} | review ${nReview} | not-worth ${nNotWorth} | pipeline $${Math.round(pipeline)}`);
} catch (e) {
  log('FATAL', e.message);
  setStatus({ running: false, startedAt, finishedAt: new Date().toISOString(), error: String(e.message).slice(0, 80) });
} finally { await ctx.close().catch(() => {}); }
process.exit(0);
