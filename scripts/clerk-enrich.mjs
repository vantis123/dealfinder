// Clerk-docket enrichment for AUCTION leads (config-per-county).
// Given an open browser context + a case number, look the case up on the county clerk site and pull:
//   - sale date / location  (Notice of Sale — from the case "Future Event(s)")
//   - VALUE SHEET pdf        (docket code VALU) -> Supabase Storage + unpaid principal/interest
//   - NOTICE OF SALE pdf     (if filed) -> Supabase Storage
//   - docket_url             (the case page, for a human to open)
//
// Seminole = LIVE (courtrecords.seminoleclerk.org, doc_view2 -> getPDFImage recipe, same as run-seminole.mjs).
// Orange/Volusia = mapping pending (each county's records host differs — add a CLERK entry per county).
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDocToStorage } from './_storage.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Per-county clerk config. Add a block here as each county's records site is mapped ("new walkthrough per county").
export const CLERK = {
  seminole: {
    ready: true,
    base: 'https://courtrecords.seminoleclerk.org/civil/',
    caseInput: '#caseNumberTxt',
    submit: '#search',
    detailRe: /civil_details/i,
    docFetch: { service: 'civil_serv.asmx/getPDFImage', idVar: /var\s+id\s*=\s*'([^']+)'/, responseKey: 'd' },
    // docket codes we care about
    codes: { value: /\bVALU\b|value sheet/i, noticeOfSale: /notice of sale/i },
  },
  // orange:  { ready:false }  // Comptroller self-service viewer — recon pending
  // volusia: { ready:false }  // recon pending
};

// doc_view2 href -> real PDF Buffer (Seminole recipe). Returns null on any failure.
async function fetchDoc(page, cfg, href) {
  try {
    const html = await (await page.request.get(new URL(href, cfg.base).href, { timeout: 30000 })).text();
    const m = html.match(cfg.docFetch.idVar); if (!m) return null;
    const r = await page.request.get(`${cfg.base}${cfg.docFetch.service}?id=${encodeURIComponent(JSON.stringify(m[1]))}`,
      { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 30000 });
    const j = JSON.parse(await r.text());
    const buf = Buffer.from(j[cfg.docFetch.responseKey], 'base64');
    return buf.slice(0, 5).toString() === '%PDF-' ? buf : null;
  } catch (e) { return null; }
}

// Parse "$123,456.78" style numbers out of the value-sheet PDF text (principal + interest = reinstatement intel).
// Reuses pdftotext if available; caller passes an `owed` extractor (same one run-seminole/run-month use).
export async function enrichCaseFromClerk({ page, county, caseNumber, sb, owed, log = () => {} }) {
  const cfg = CLERK[(county || '').toLowerCase()];
  const out = { sale_date: null, sale_location: null, value_sheet_url: null, notice_of_sale_url: null, unpaid_principal: null, interest_owed: null, docket_url: null };
  if (!cfg || !cfg.ready) return out;
  try {
    // Seminole NoBot timing captcha: type like a human + pause before submit, retry a few times.
    // Keep THIS page exclusively for searching — all detail/doc work happens on a throwaway page —
    // so navigating to case details never corrupts the next search (that was the flakiness).
    let href = null;
    for (let attempt = 1; attempt <= 4 && !href; attempt++) {
      await page.goto(cfg.base, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1500);
      if (!(await page.$(cfg.caseInput))) { log(`clerk: ${caseNumber} no search form`); return out; }
      await page.fill(cfg.caseInput, '');
      await page.type(cfg.caseInput, caseNumber, { delay: 45 });
      await sleep(1600 + attempt * 400);                 // human pause -> NoBot passes
      await Promise.all([page.waitForLoadState('load').catch(() => {}), page.click(cfg.submit).catch(() => {})]);
      await sleep(2600);
      href = await page.evaluate(({ cn, re }) => {
        const n = s => (s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const a = [...document.querySelectorAll('a')].find(x => n(x.innerText).includes(n(cn)) && new RegExp(re, 'i').test(x.getAttribute('href') || ''));
        return a ? a.getAttribute('href') : null;
      }, { cn: caseNumber, re: cfg.detailRe.source });
      if (!href && attempt < 4) { log(`clerk: ${caseNumber} try ${attempt} → 0, retry`); await sleep(1200); }
    }
    if (!href) { log(`clerk: no result for ${caseNumber}`); return out; }

    // detail + docket + docs on a THROWAWAY page so the search page/session stays pristine
    const detailUrl = new URL(href, cfg.base).href;
    out.docket_url = detailUrl;
    const dp = await page.context().newPage();
    try {
      await dp.goto(detailUrl, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      // Future Event(s) -> sale date + location (the "Notice of Sale, which is the date")
      const fe = await dp.evaluate(() => { const m = document.body.innerText.match(/Future Event\(s\)?:?\s*([\s\S]{0,220})/i); return m ? m[1] : null; });
      if (fe) {
        const dm = fe.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
        if (dm) out.sale_date = dm[1];
        const loc = fe.match(/([A-Z][A-Z .]*COURTHOUSE[A-Z .]*)/i);
        if (loc) out.sale_location = loc[1].trim();
      }
      // docket grid -> VALUE SHEET + NOTICE OF SALE doc links
      const rows = await dp.evaluate(() => {
        const trs = [...document.querySelectorAll('#docketGrid tbody tr, table[id*=docketGrid] tbody tr')];
        return trs.map(tr => { const txt = (tr.innerText || '').replace(/\s+/g, ' ').trim(); const a = tr.querySelector('a[href*="doc_view2"]'); return { txt, doc: a ? a.getAttribute('href') : null }; }).filter(r => r.doc);
      });
      const valuRow = rows.find(r => cfg.codes.value.test(r.txt));
      const nosRow = rows.find(r => cfg.codes.noticeOfSale.test(r.txt));
      if (valuRow) {
        const buf = await fetchDoc(dp, cfg, valuRow.doc);
        if (buf) {
          out.value_sheet_url = await saveDocToStorage(sb, caseNumber, 'value-sheet', buf) || null;
          if (owed) { const f = join(tmpdir(), `auc-val-${caseNumber.replace(/[^A-Za-z0-9]/g, '_')}.pdf`); try { writeFileSync(f, buf); const o = await owed(f); out.unpaid_principal = o.principalDue ?? null; out.interest_owed = o.interestOwed ?? null; } catch (e) {} finally { try { unlinkSync(f); } catch (e) {} } }
          log(`clerk: ${caseNumber} value sheet saved (${buf.length}b, principal=${out.unpaid_principal})`);
        }
      } else log(`clerk: ${caseNumber} no VALU docket row`);
      if (nosRow) { const buf = await fetchDoc(dp, cfg, nosRow.doc); if (buf) out.notice_of_sale_url = await saveDocToStorage(sb, caseNumber, 'notice-of-sale', buf) || null; }
    } finally { await dp.close().catch(() => {}); }
  } catch (e) { log(`clerk enrich err ${caseNumber}:`, String(e.message).slice(0, 100)); }
  return out;
}

// ---- ORANGE: Comptroller (occompt) Final Judgment via reCAPTCHA disclaimer -> servepdf PDF ----
// Needs the "Final Judgment" occompt doc URL scraped off the RealForeclose detail page (fjDocUrl).
// Solves the disclaimer reCAPTCHA ONCE per run (state.accepted); the session cookie carries the rest.
const OCCOMPT_HOST = 'https://selfservice.or.occompt.com';
const OCCOMPT_SITEKEY = '6LemVGAUAAAAAB_iW1wbaE4_s0Z5SoSakm6GI8St';
const capPost = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
async function solveOccompt(capKey, log) {
  for (const type of ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess']) {
    const c = await capPost('https://api.capsolver.com/createTask', { clientKey: capKey, task: { type, websiteURL: `${OCCOMPT_HOST}/ssweb/user/disclaimer`, websiteKey: OCCOMPT_SITEKEY } });
    if (c.errorId) { log('capsolver createTask err:', c.errorDescription); continue; }
    for (let i = 0; i < 24 && c.taskId; i++) {
      await sleep(3000);
      const r = await capPost('https://api.capsolver.com/getTaskResult', { clientKey: capKey, taskId: c.taskId });
      if (r.status === 'ready') return r.solution.gRecaptchaResponse;
      if (r.status === 'failed' || r.errorId) break;
    }
  }
  return null;
}

export async function enrichOrangeFJ({ page, caseNumber, fjDocUrl, capKey, sb, owed, log = () => {}, state = {} }) {
  const out = { sale_date: null, sale_location: null, value_sheet_url: null, notice_of_sale_url: null, final_judgment_url: null, unpaid_principal: null, interest_owed: null, docket_url: fjDocUrl || null };
  if (!fjDocUrl) { log(`orange: ${caseNumber} no Final Judgment link on detail page`); return out; }
  try {
    // Up to 2 attempts — the occompt viewer/captcha is occasionally flaky; a retry recovers it.
    for (let attempt = 1; attempt <= 2 && !out.final_judgment_url; attempt++) {
      await page.goto(fjDocUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2500);
      // disclaimer gate?
      if (/\/disclaimer/i.test(page.url()) || await page.$('#g-recaptcha-response, .g-recaptcha, [data-sitekey]')) {
        const tok = await solveOccompt(capKey, log);
        if (!tok) { log(`orange: ${caseNumber} captcha unsolved (attempt ${attempt})`); await sleep(1500); continue; }
        await page.evaluate((t) => {
          let ta = document.getElementById('g-recaptcha-response');
          if (!ta) { ta = document.createElement('textarea'); ta.id = 'g-recaptcha-response'; ta.name = 'g-recaptcha-response'; ta.style.display = 'none'; (document.querySelector('form') || document.body).appendChild(ta); }
          ta.value = t;
          const el = document.querySelector('[data-callback]'); const cb = el && el.getAttribute('data-callback');
          if (cb && typeof window[cb] === 'function') { try { window[cb](t); } catch (e) {} }
          [...document.querySelectorAll('button,input')].forEach(b => { if (/accept/i.test(b.innerText || b.value || '')) b.removeAttribute('disabled'); });
        }, tok);
        await sleep(800);
        await page.evaluate(() => { const b = [...document.querySelectorAll('button,input,a')].find(x => /^\s*i accept\s*$/i.test((x.innerText || x.value || '').trim())); if (b) b.click(); });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await sleep(4000);
        state.accepted = true;
      }
      // extract the real PDF path (PDF.js viewer iframe -> file=/ssweb/document/servepdf/...pdf)
      const fileParam = await page.evaluate(() => {
        const ifr = [...document.querySelectorAll('iframe,embed')].map(e => e.src).filter(Boolean);
        for (const u of ifr) { const m = u.match(/[?&]file=([^&]+?)(?:&(?:index|allow)|$)/i); if (m) return decodeURIComponent(m[1]); }
        return null;
      });
      if (!fileParam) { log(`orange: ${caseNumber} no servepdf ref (attempt ${attempt})`); await sleep(1500); continue; }
      const r = await page.request.get(new URL(fileParam, OCCOMPT_HOST).href, { timeout: 40000 });
      const buf = Buffer.from(await r.body());
      if (buf.slice(0, 5).toString() !== '%PDF-') { log(`orange: ${caseNumber} servepdf not a PDF (attempt ${attempt})`); await sleep(1500); continue; }
      out.final_judgment_url = await saveDocToStorage(sb, caseNumber, 'final-judgment', buf) || null;
      if (owed) {
        const f = join(tmpdir(), `auc-fj-${caseNumber.replace(/[^A-Za-z0-9]/g, '_')}.pdf`);
        try { writeFileSync(f, buf); const o = await owed(f); out.unpaid_principal = o.principalDue ?? null; out.interest_owed = o.interestOwed ?? null; } catch (e) {} finally { try { unlinkSync(f); } catch (e) {} }
      }
      log(`orange: ${caseNumber} FJ saved (${buf.length}b, principal=${out.unpaid_principal})`);
    }
  } catch (e) { log(`orange enrich err ${caseNumber}:`, String(e.message).slice(0, 100)); }
  return out;
}

// Dispatcher: pick the right enrichment per county.
export async function enrichAuctionCase(opts) {
  const county = (opts.county || '').toLowerCase();
  if (county === 'orange') return enrichOrangeFJ(opts);
  if (CLERK[county]?.ready) return enrichCaseFromClerk(opts);
  return { sale_date: null, sale_location: null, value_sheet_url: null, notice_of_sale_url: null, final_judgment_url: null, unpaid_principal: null, interest_owed: null, docket_url: null };
}
