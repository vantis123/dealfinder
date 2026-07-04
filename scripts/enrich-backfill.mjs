// Backfill documents for every auction lead missing them.
//   Seminole -> clerk value sheet (no login).
//   Orange   -> log into RealForeclose to grab each case's "Final Judgment" link, then Comptroller PDF.
// Paced + circuit-broken so it won't trip the records sites' rate limits.
// Run: COUNTY=seminole|orange|both LIMIT=0 HEADLESS=1 /usr/local/bin/node scripts/enrich-backfill.mjs
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';
import { enrichAuctionCase } from './clerk-enrich.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const execFileP = promisify(execFile);
const WHICH = (process.env.COUNTY || 'both').toLowerCase();
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const HEADLESS = process.env.HEADLESS !== '0';
const PACE = parseInt(process.env.PACE_MS || '3000', 10);
const USER = env.REALFORECLOSE_USER || process.env.REALFORECLOSE_USER;
const PASS = env.REALFORECLOSE_PASS || process.env.REALFORECLOSE_PASS;
const money = (s) => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function owed(file) {
  try {
    const tmp = join(tmpdir(), `bf-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]);
    const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 8e7 });
    try { unlinkSync(`${tmp}.png`); } catch (e) {}
    const p = stdout.match(/Principal\s+(?:Balance|due)[:\s]*\$?([\d][\d,]*\.\d{2})/i);
    const i = stdout.match(/(?:Accrued\s+Interest|Interest\s+owed)[^\n$]{0,60}\$?([\d][\d,]*\.\d{2})/i);
    if (p || i) return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null };
  } catch (e) { /* fall through */ }
  try {
    const b64 = readFileSync(file).toString('base64');
    const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'FL foreclosure Final Judgment or Value of Real Property form. Return ONLY JSON {"principalDue":number,"interestOwed":number}.' }] }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) };
  } catch (e) { return {}; }
}

async function upsertDocs(caseNumber, r) {
  const patch = { sale_date: r.sale_date, sale_location: r.sale_location, value_sheet_url: r.value_sheet_url, notice_of_sale_url: r.notice_of_sale_url, final_judgment_url: r.final_judgment_url, unpaid_principal: r.unpaid_principal, interest_owed: r.interest_owed, enriched_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  Object.keys(patch).forEach((k) => patch[k] == null && delete patch[k]);
  if (Object.keys(patch).length > 2) await sb.from('auction_leads').update(patch).eq('case_number', caseNumber);
}

async function missing(county) {
  const { data } = await sb.from('auction_leads').select('case_number,detail_url').ilike('county', county).is('value_sheet_url', null).is('final_judgment_url', null);
  let rows = (data || []).filter((r) => r.case_number);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  return rows;
}

const { Camoufox } = await import('camoufox-js');

async function backfillSeminole() {
  const rows = await missing('seminole');
  if (!rows.length) return log('seminole: nothing missing');
  log(`seminole: ${rows.length} to backfill (clerk, free)`);
  const ctx = await Camoufox({ headless: HEADLESS, user_data_dir: join(ROOT, '.rf-session', 'seminole-enrich-cf') });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
  let done = 0, docs = 0, miss = 0;
  try {
    for (const row of rows) {
      const r = await enrichAuctionCase({ page, county: 'seminole', caseNumber: row.case_number, sb, owed, log });
      await upsertDocs(row.case_number, r);
      done++;
      if (r.value_sheet_url) { docs++; miss = 0; } else if (!r.docket_url) miss++;
      if (done % 10 === 0) log(`  seminole ${done}/${rows.length} (${docs} docs)`);
      if (miss >= 6) { log('seminole: 6 consecutive misses — clerk throttling, stopping (resume later)'); break; }
      await sleep(PACE);
    }
  } finally { await ctx.close(); }
  log(`seminole done: ${docs}/${rows.length} docs saved`);
}

async function backfillOrange() {
  const rows = await missing('orange');
  if (!rows.length) return log('orange: nothing missing');
  if (!USER || !PASS) return log('orange: SKIPPED — set REALFORECLOSE_USER/PASS to backfill Orange');
  log(`orange: ${rows.length} to backfill (RealForeclose login + Comptroller)`);
  const ctx = await Camoufox({ headless: HEADLESS, user_data_dir: join(ROOT, '.rf-session', 'orange-cf') });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
  const clearOKs = async (n = 6) => { for (let i = 0; i < n; i++) { await sleep(900); const c = await page.evaluate(() => { const e = [...document.querySelectorAll('button,a,input,div[onclick],span[onclick]')].find((x) => /^(ok|continue|i agree|accept|proceed|enter)$/i.test((x.innerText || x.value || '').trim())); if (e) { e.click(); return true; } return false; }).catch(() => false); if (!c) break; } };
  const state = {};
  let done = 0, docs = 0;
  try {
    // login to orange RealForeclose (once)
    await page.goto('https://orange.realforeclose.com/index.cfm?ZACTION=USER&ZMETHOD=CALENDAR', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    if (await page.$('#LogName')) { log('orange: logging into RealForeclose…'); await page.fill('#LogName', USER); await page.fill('#LogPass', PASS); await page.click('#LogButton').catch(() => {}); await sleep(3500); await clearOKs(); }
    else { log('orange: RealForeclose session reused'); await clearOKs(2); }
    for (const row of rows) {
      let fjDocUrl = null;
      if (row.detail_url) {
        try { await page.goto(row.detail_url, { waitUntil: 'domcontentloaded' }); await sleep(1200); await clearOKs(1);
          fjDocUrl = await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find((x) => /^\s*final judgment\s*$/i.test((x.innerText || '').trim())); return a ? a.getAttribute('href') : null; }); } catch (e) {}
      }
      const r = await enrichAuctionCase({ page, county: 'orange', caseNumber: row.case_number, fjDocUrl, capKey: env.CAPSOLVER_API_KEY, sb, owed, log, state });
      await upsertDocs(row.case_number, r);
      done++;
      if (r.final_judgment_url) docs++;
      if (done % 10 === 0) log(`  orange ${done}/${rows.length} (${docs} docs)`);
      await sleep(PACE);
    }
  } finally { await ctx.close(); }
  log(`orange done: ${docs}/${rows.length} docs saved`);
}

log(`backfill start — county=${WHICH} limit=${LIMIT || 'all'}`);
if (WHICH === 'seminole' || WHICH === 'both') await backfillSeminole();
if (WHICH === 'orange' || WHICH === 'both') await backfillOrange();
log('backfill complete');
