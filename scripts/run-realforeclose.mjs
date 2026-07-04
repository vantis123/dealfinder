// RealForeclose (RealAuction) AUCTION scraper.
// Walks a county's auction calendar for EVERY future sale date and pulls each foreclosure
// listing + Final Judgment amount into Deal Finder. Distinct from the clerk pre-foreclosure
// scraper (run-month.mjs) — this is the AUCTION stage.
//
// Mapped live 2026-07-02 (Seminole + Orange). Full spec: arvantis-brain/products/deal-finder/realforeclose-auction-scraping.md
// Flow: login (#LogName/#LogPass/#LogButton) -> clear OK prompts -> CALENDAR
//       -> read .CALBOX[dayid] (auction days) -> click blue next-month link ("August> >")
//       -> per date: DAYLIST&AUCTIONDATE=MM/DD/YYYY -> parse each auction (Label:\tvalue).
//
// Run:  COUNTY=seminole HEADLESS=0 node run-realforeclose.mjs
// Env (.env.local): REALFORECLOSE_USER, REALFORECLOSE_PASS
// NOTE: verified selectors, but the DAYLIST per-item parse should get one live tune pass
//       once the site un-blocks (we were rate-limited during the build).
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';
import { enrichAuctionCase } from './clerk-enrich.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');       // container-safe (relative), matches the other scripts
const env = loadEnv(ROOT);                // .env locally, Railway vars in the container

const COUNTY = (process.env.COUNTY || 'seminole').toLowerCase();
const USER = env.REALFORECLOSE_USER || process.env.RF_USER;
const PASS = env.REALFORECLOSE_PASS || process.env.RF_PASS;
const HEADLESS = process.env.HEADLESS !== '0';
const ENGINE = process.env.ENGINE || 'chromium';                             // 'camoufox' = stealth (beats the 403)
const MONTHS_AHEAD = parseInt(process.env.MONTHS_AHEAD || '9', 10);          // walk rest of year
const MAX_DATES = parseInt(process.env.MAX_DATES || '0', 10);                // 0 = all; >0 limits (for quick tests)
const SPREAD = parseInt(process.env.AUCTION_SPREAD || '100000', 10);         // Phillip's auction equity floor
const base = `https://${COUNTY}.realforeclose.com`;
const UDD = join(ROOT, '.rf-session', COUNTY);   // browser profile — writable, container-safe
const OUTDIR = process.env.DF_OUT || '/tmp/df-out';
const ENRICH = process.env.ENRICH !== '0';                                   // pull clerk/comptroller docs (value sheet / final judgment)
const ENRICH_MAX = parseInt(process.env.ENRICH_MAX || '0', 10);              // 0 = all; >0 caps enrichment (testing)
const CAP = env.CAPSOLVER_API_KEY;                                           // Orange occompt reCAPTCHA
const USE_AI = process.env.USE_AI !== '0';
const execFileP = promisify(execFile);
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });

// Reinstatement extractor — reads Principal + Interest off a value sheet OR final judgment PDF.
// OCR first (handles scanned Orange FJs); regex both label styles; Claude vision fallback.
async function extractOwed(file) {
  try {
    const tmp = join(tmpdir(), `rf-ocr-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]);
    const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 8e7 });
    try { unlinkSync(`${tmp}.png`); } catch (e) {}
    const p = stdout.match(/(?:Principal\s+(?:Balance|due)[:\s]*\$?|\$?)([\d][\d,]*\.\d{2})[^\n]{0,20}Principal\s+due/i)
      || stdout.match(/Principal\s+(?:Balance|due)[:\s]*\$?([\d][\d,]*\.\d{2})/i);
    const i = stdout.match(/(?:Accrued\s+Interest|Interest\s+owed)[^\n$]{0,60}\$?([\d][\d,]*\.\d{2})/i)
      || stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest\s+owed/i);
    if (p || i) return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null };
  } catch (e) { /* OCR tools may be absent locally — fall through to Claude */ }
  if (!USE_AI) return {};
  try {
    const b64 = readFileSync(file).toString('base64');
    const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'This is a Florida foreclosure Final Judgment or "Value of Real Property" form. Return ONLY JSON {"principalDue":number,"interestOwed":number} — principal balance owed and accrued/total interest. Numbers only, no text.' }] }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) };
  } catch (e) { return {}; }
}

// Only real property — skip timeshares / liquor-license parcels (Phillip's rule)
const SKIP_PARCEL = /timeshare|alcoholic\s+license/i;
const money = s => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- clear the (variable) OK / notice gauntlet ----
async function clearOKs(page, n = 6) {
  for (let i = 0; i < n; i++) {
    await sleep(1000);
    const clicked = await page.evaluate(() => {
      const e = [...document.querySelectorAll('button,a,input,div[onclick],span[onclick]')]
        .find(x => /^(ok|continue|i agree|accept|proceed|enter|confirm)$/i.test((x.innerText || x.value || '').trim()));
      if (e) { e.click(); return true; } return false;
    }).catch(() => false);
    if (!clicked) break;
  }
}

async function ensureLogin(page) {
  await page.goto(`${base}/index.cfm?ZACTION=USER&ZMETHOD=CALENDAR`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  if (await page.$('#LogName')) {
    log('logging in…');
    await page.fill('#LogName', USER);
    await page.fill('#LogPass', PASS);
    await page.click('#LogButton').catch(() => {});
    await sleep(3500);
    await clearOKs(page);
    await page.goto(`${base}/index.cfm?ZACTION=USER&ZMETHOD=CALENDAR`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await clearOKs(page, 3);
  } else {
    log('session reused (no re-login)');
    await clearOKs(page, 2);
  }
}

// ---- walk the calendar month-by-month, collect future auction dates ----
async function collectAuctionDates(page) {
  const dates = new Set();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let month = 0; month < MONTHS_AHEAD; month++) {
    await page.waitForFunction(() => document.querySelector('.CALBOX'), { timeout: 12000 }).catch(() => {});
    const days = await page.$$eval('.CALBOX[dayid]', els => els.map(e => ({ d: e.getAttribute('dayid'), t: e.innerText || '' })));
    let added = 0;
    for (const { d, t } of days) {
      if (!/FC|foreclosure/i.test(t)) continue;               // day has foreclosure auction(s)
      const [m, dd, y] = d.split('/').map(Number);
      if (new Date(y, m - 1, dd) >= today) { dates.add(d); added++; }
    }
    log(`month ${month + 1}/${MONTHS_AHEAD}: +${added} auction day(s)`);
    // click the blue NEXT-month link (text like "August> >" — has ">" arrows, not "<<")
    const advanced = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a')];
      const nx = links.find(a => {
        const t = (a.innerText || '').trim();
        return />\s*>/.test(t) || (/[A-Za-z]{3,}/.test(t) && t.includes('>') && !t.includes('<'));
      });
      if (nx) { nx.click(); return true; } return false;
    });
    if (!advanced) { log('no next-month link — stopping'); break; }
    await sleep(2500);
    await clearOKs(page, 1);
  }
  return [...dates];
}

// ---- parse one auction day's listings ----
async function parseDay(page, date) {
  await page.goto(`${base}/index.cfm?zaction=AUCTION&Zmethod=DAYLIST&AUCTIONDATE=${date}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await clearOKs(page, 2);
  await page.waitForFunction(() => /final judgment|no auctions|case #/i.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const items = await page.$$eval('a[href*="zmethod=details"], a[href*="ZMETHOD=DETAILS"]', links => {
    const g = (txt, re) => { const m = txt.match(re); return m ? m[1].trim().replace(/\s{2,}/g, ' ') : null; };
    const seen = {};
    const out = [];
    for (const a of links) {
      // climb to the auction block (nearest ancestor holding "Final Judgment")
      let el = a;
      for (let i = 0; i < 9 && el; i++) { if (/final judgment/i.test(el.innerText || '')) break; el = el.parentElement; }
      const txt = (el && el.innerText) || '';
      if (!/case #/i.test(txt)) continue;
      const caseNumber = (a.innerText || '').trim() || g(txt, /Case #:\s*([^\n]+)/i);
      if (!caseNumber || seen[caseNumber]) continue; seen[caseNumber] = 1;
      const href = a.getAttribute('href') || '';
      out.push({
        aid: (href.match(/AID=(\d+)/i) || [])[1] || null,
        caseNumber,
        type: g(txt, /Auction Type:\s*([^\n]+)/i),
        status: g(txt, /Auction Status\s*\n?\s*([^\n]+)/i) || g(txt, /(Canceled[^\n]*|Auction Sold|Rescheduled)/i) || 'Scheduled',
        finalJudgment: g(txt, /Final Judgment Amount:\s*\$?([\d,]+\.?\d*)/i),
        parcelId: g(txt, /Parcel ID:\s*([^\n]+)/i),
        address: (() => {  // RealForeclose splits street / "CITY, FL zip" across 2 lines — rejoin with a comma so Zillow matches
          const am = txt.match(/Property Address:\s*([^\n]+)\n\s*([A-Za-z0-9 .]+,\s*FL[-\s]*\d{5})/i);
          if (am) return `${am[1].trim()}, ${am[2].trim().replace(/FL-\s*/i, 'FL ')}`;
          const m2 = txt.match(/Property Address:\s*([^\n]+)/i);
          return m2 ? m2[1].trim() : null;
        })(),
        assessed: g(txt, /Assessed Value:\s*\$?([\d,]+\.?\d*)/i),
        detailPath: href,
      });
    }
    return out;
  }).catch(() => []);
  return items;
}

// ---- Supabase: DEDICATED `auction_leads` table — kept SEPARATE from the clerk pre-foreclosure
//      `foreclosure_leads` so the two never mix in the UI. ----
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function upsert(rec) {
  try {
    await sb.from('auction_leads').upsert({
      case_number: rec.caseNumber,
      county: COUNTY[0].toUpperCase() + COUNTY.slice(1),
      auction_date: rec.auctionDate || null,
      auction_status: rec.status || null,
      auction_type: rec.type || null,
      parcel_id: rec.parcelId || null,
      property_address: rec.address || null,
      final_judgment: rec.finalJudgment ?? null,
      assessed_value: rec.assessed ?? null,
      zillow_value: rec.zillow ?? null,
      value_used: rec.value ?? null,
      value_source: rec.valueSource || null,
      spread: rec.spread ?? null,
      flagged: rec.flagged ?? null,
      detail_url: rec.detailPath ? base + rec.detailPath : null,
      sale_date: rec.sale_date ?? null,
      sale_location: rec.sale_location ?? null,
      value_sheet_url: rec.value_sheet_url ?? null,
      notice_of_sale_url: rec.notice_of_sale_url ?? null,
      final_judgment_url: rec.final_judgment_url ?? null,
      unpaid_principal: rec.unpaid_principal ?? null,
      interest_owed: rec.interest_owed ?? null,
      enriched_at: rec.enriched_at ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'case_number' });
  } catch (e) { log('upsert err', String(e.message).slice(0, 50)); }
}

// ---- Zillow market value via Apify (rotating proxies). Assessed value undervalues, so this is
//      what surfaces the real deals. Same actor the clerk scraper uses. ----
const APIFY = env.APIFY_API_TOKEN || null;   // set APIFY_API_TOKEN as a Railway env var
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanAddr = a => String(a || '').replace(/FL-\s*/i, 'FL ').replace(/\s{2,}/g, ' ').trim();
async function valueViaApify(recs) {
  const withAddr = recs.filter(r => r.address);
  if (!APIFY || !withAddr.length) { log('apify: skipped (no token or addresses)'); return; }
  const addresses = [...new Set(withAddr.map(r => cleanAddr(r.address)))];
  log(`apify: valuing ${addresses.length} address(es) via Zillow…`);
  try {
    const start = await fetch(`https://api.apify.com/v2/acts/maxcopell~zillow-detail-scraper/runs?token=${APIFY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses }) }).then(r => r.json());
    const runId = start.data?.id, dsId = start.data?.defaultDatasetId;
    let status = 'RUNNING';
    for (let i = 0; i < 120 && (status === 'RUNNING' || status === 'READY'); i++) {
      await sleep(5000);
      const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`).then(r => r.json());
      status = s.data?.status;
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') break;
    }
    log('apify:', status);
    const items = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY}&fields=addressOrUrlFromInput,streetAddress,zestimate,price,taxAssessedValue`).then(r => r.json());
    const byInput = new Map(), byStreet = new Map();
    for (const it of items) { const v = it.zestimate || it.price || it.taxAssessedValue || null; if (it.addressOrUrlFromInput) byInput.set(norm(it.addressOrUrlFromInput), v); if (it.streetAddress) byStreet.set(norm(it.streetAddress), v); }
    let valued = 0;
    for (const r of recs) { if (!r.address) continue; let z = byInput.get(norm(cleanAddr(r.address))); if (z == null) z = byStreet.get(norm(r.address.split(',')[0])); if (z != null) { r.zillow = z; valued++; } }
    log(`apify: valued ${valued}/${withAddr.length}`);
  } catch (e) { log('apify err', String(e.message).slice(0, 80)); }
}

// ---- main ----
let ctx;
if (ENGINE === 'camoufox') {
  const { Camoufox } = await import('camoufox-js');            // Firefox-based stealth (defeats fingerprint blocks)
  ctx = await Camoufox({ headless: HEADLESS, user_data_dir: `${UDD}-cf` });
  log('engine: camoufox (stealth)');
} else {
  ctx = await chromium.launchPersistentContext(UDD, { headless: HEADLESS, slowMo: HEADLESS ? 0 : 300, viewport: { width: 1440, height: 950 }, acceptDownloads: true });
}
const page = ctx.pages()[0] || await ctx.newPage();
page.on('dialog', async d => { await d.accept().catch(() => {}); });

const all = [];
try {
  await ensureLogin(page);
  let dates = await collectAuctionDates(page);
  if (MAX_DATES) dates = dates.slice(0, MAX_DATES);
  log(`${dates.length} future auction date(s) for ${COUNTY}${MAX_DATES ? ` (capped at ${MAX_DATES})` : ''}`);
  for (const date of dates) {
    const items = await parseDay(page, date);
    let kept = 0;
    for (const it of items) {
      if (it.parcelId && SKIP_PARCEL.test(it.parcelId)) continue;   // skip timeshare / liquor license
      if (it.address && SKIP_PARCEL.test(it.address)) continue;
      if (!it.address || !it.address.trim()) continue;              // no real address -> never add to the CRM (Phillip's rule)
      it.auctionDate = date;
      it.finalJudgment = money(it.finalJudgment);
      it.assessed = money(it.assessed);
      it.value = it.assessed;                                       // preliminary; overwritten by Zillow below
      it.spread = (it.value && it.finalJudgment) ? it.value - it.finalJudgment : null;
      it.flagged = it.spread != null ? it.spread >= SPREAD : null;
      all.push(it);
      kept++;
    }
    log(`  ${date}: ${items.length} listing(s), kept ${kept}`);
    await sleep(800);                                               // gentle pacing (avoid rate-limit)
  }
  // Orange: the Final Judgment doc lives behind the per-case detail page's "Final Judgment" link
  // (Comptroller occompt URL). Grab it now while we're still logged into RealForeclose.
  if (COUNTY === 'orange' && ENRICH) {
    const targets = ENRICH_MAX ? all.slice(0, ENRICH_MAX) : all;
    log(`capturing Final Judgment links for ${targets.length} Orange case(s)…`);
    for (const it of targets) {
      if (!it.detailPath) continue;
      try {
        await page.goto(new URL(it.detailPath, base).href, { waitUntil: 'domcontentloaded' });
        await sleep(1200); await clearOKs(page, 1);
        it.fjDocUrl = await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => /^\s*final judgment\s*$/i.test((x.innerText || '').trim())); return a ? a.getAttribute('href') : null; });
      } catch (e) { /* skip */ }
    }
    log(`FJ links found: ${targets.filter(t => t.fjDocUrl).length}/${targets.length}`);
  }
} catch (e) {
  log('ERROR', String(e.message).slice(0, 200));
} finally {
  await ctx.close();
}

// ---- value via Zillow (market), recompute spread on market value (fallback assessed) ----
await valueViaApify(all);
for (const it of all) {
  // Zillow (market) is normally >= assessed. If it comes back far BELOW assessed, it's a bad
  // match (e.g. Zillow returned a vacant-lot/junk $5k) -> trust the assessed floor instead.
  it.value = (it.zillow && it.assessed && it.zillow < it.assessed * 0.5) ? it.assessed : (it.zillow ?? it.assessed);
  it.valueSource = (it.value === it.zillow) ? 'zillow' : 'assessed';
  it.spread = (it.value && it.finalJudgment) ? it.value - it.finalJudgment : null;
  it.flagged = it.spread != null ? it.spread >= SPREAD : null;
}

// ---- ENRICH: pull the value sheet / final judgment doc + sale date + reinstatement $ per case ----
// Seminole = clerk docket (free). Orange = Comptroller Final Judgment (CapSolver, one solve/run).
if (ENRICH) {
  const targets = (ENRICH_MAX ? all.slice(0, ENRICH_MAX) : all);
  log(`enriching ${targets.length} case(s) via clerk/comptroller…`);
  const { Camoufox } = await import('camoufox-js');
  const ectx = await Camoufox({ headless: HEADLESS, user_data_dir: join(ROOT, '.rf-session', `${COUNTY}-enrich-cf`) });
  const epage = ectx.pages()[0] || await ectx.newPage();
  epage.on('dialog', async d => { await d.accept().catch(() => {}); });
  const state = {};                                                // shared across Orange cases -> one captcha solve/run
  const PACE = parseInt(process.env.ENRICH_PACE_MS || '3000', 10);  // gentle gap between cases (gov sites rate-limit bursts)
  let done = 0, docs = 0, miss = 0;
  for (const it of targets) {
    try {
      const r = await enrichAuctionCase({ page: epage, county: COUNTY, caseNumber: it.caseNumber, fjDocUrl: it.fjDocUrl, capKey: CAP, sb, owed: extractOwed, log, state });
      Object.assign(it, r);
      if (r.value_sheet_url || r.final_judgment_url) { docs++; miss = 0; it.enriched_at = new Date().toISOString(); }
      else if (!r.docket_url && !r.sale_date) { miss++; }          // no record found at all
      done++;
      if (done % 10 === 0) log(`  enriched ${done}/${targets.length} (${docs} docs saved)`);
      // circuit breaker: if the records site starts refusing everything (rate-limit), stop hammering —
      // the rest get picked up on the next run rather than deepening the block.
      if (miss >= 6) { log(`enrichment: ${miss} consecutive misses — records site likely throttling, stopping this run`); break; }
    } catch (e) { log('enrich err', it.caseNumber, String(e.message).slice(0, 80)); }
    await sleep(PACE + Math.floor(PACE * 0.4 * (done % 3) / 3));   // small jitter
  }
  await ectx.close();
  log(`enrichment done: ${docs}/${targets.length} docs saved`);
}

// ---- persist ----
for (const it of all) await upsert(it);
log(`valued + persisted ${all.length} | flagged ${all.filter(r => r.flagged).length} | docs ${all.filter(r => r.value_sheet_url || r.final_judgment_url).length}`);

// ---- CSV output ----
mkdirSync(OUTDIR, { recursive: true });
const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
const head = ['Auction Date', 'County', 'Case #', 'Status', 'Final Judgment', 'Assessed', 'Zillow', 'Value Used', 'Src', 'Spread', 'Flag', 'Parcel ID', 'Address'];
const lines = [head.map(esc).join(',')];
for (const r of all.sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0) || (b.spread || 0) - (a.spread || 0)))
  lines.push([r.auctionDate, COUNTY, r.caseNumber, r.status, r.finalJudgment || '', r.assessed || '', r.zillow || '', r.value || '', r.valueSource || '', r.spread || '', r.flagged ? 'KNOCK' : '', r.parcelId || '', r.address || ''].map(esc).join(','));
writeFileSync(`${OUTDIR}/auctions-${COUNTY}.csv`, lines.join('\n'));
log(`DONE ${COUNTY}: ${all.length} listings | flagged ${all.filter(r => r.flagged).length} | wrote auctions-${COUNTY}.csv`);
process.exit(0);
