// Enrich ONE auction case on demand: pull + save its docs (value sheet / final judgment / notice of sale),
// sale date and reinstatement $, then upsert those onto auction_leads. Prints a JSON result.
// Run: CASE=2023CA003090 COUNTY=seminole HEADLESS=1 /usr/local/bin/node scripts/enrich-one.mjs
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
const CASE = process.env.CASE;
const COUNTY = (process.env.COUNTY || 'seminole').toLowerCase();
const HEADLESS = process.env.HEADLESS !== '0';
const money = (s) => { const m = (s == null ? '' : String(s)).replace(/[^0-9.]/g, ''); return m ? parseFloat(m) : null; };
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
if (!CASE) { console.log(JSON.stringify({ error: 'CASE required' })); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function owed(file) {
  try {
    const tmp = join(tmpdir(), `e1-${process.pid}`);
    await execFileP('pdftoppm', ['-r', '200', '-png', '-singlefile', file, tmp]);
    const { stdout } = await execFileP('tesseract', [`${tmp}.png`, '-'], { maxBuffer: 8e7 });
    try { unlinkSync(`${tmp}.png`); } catch (e) {}
    const p = stdout.match(/Principal\s+(?:Balance|due)[:\s]*\$?([\d][\d,]*\.\d{2})/i);
    const i = stdout.match(/(?:Accrued\s+Interest|Interest\s+owed)[^\n$]{0,60}\$?([\d][\d,]*\.\d{2})/i);
    if (p || i) return { principalDue: p ? money(p[1]) : null, interestOwed: i ? money(i[1]) : null };
  } catch (e) { /* fall through to AI */ }
  try {
    const b64 = readFileSync(file).toString('base64');
    const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'FL foreclosure Final Judgment or Value of Real Property form. Return ONLY JSON {"principalDue":number,"interestOwed":number}.' }] }] });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) };
  } catch (e) { return {}; }
}

const { Camoufox } = await import('camoufox-js');
const ctx = await Camoufox({ headless: HEADLESS, user_data_dir: join(ROOT, '.rf-session', `${COUNTY}-enrich-cf`) });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
let fjDocUrl = null;
try {
  // Orange needs the Comptroller "Final Judgment" link off the listing detail page — which requires a
  // RealForeclose login. Open the detail page; if it shows the login form, sign in and reload, then grab the link.
  if (COUNTY === 'orange') {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const USER = env.REALFORECLOSE_USER || process.env.REALFORECLOSE_USER;
    const PASS = env.REALFORECLOSE_PASS || process.env.REALFORECLOSE_PASS;
    const clearOKs = async (n = 6) => { for (let i = 0; i < n; i++) { await sleep(900); const c = await page.evaluate(() => { const e = [...document.querySelectorAll('button,a,input,div[onclick],span[onclick]')].find((x) => /^(ok|continue|i agree|accept|proceed|enter)$/i.test((x.innerText || x.value || '').trim())); if (e) { e.click(); return true; } return false; }).catch(() => false); if (!c) break; } };
    const { data } = await sb.from('auction_leads').select('detail_url').eq('case_number', CASE).maybeSingle();
    if (data?.detail_url) {
      await page.goto(data.detail_url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1500);
      if ((await page.$('#LogName')) && USER && PASS) {
        console.error('orange: logging into RealForeclose…');
        await page.fill('#LogName', USER); await page.fill('#LogPass', PASS);
        await page.click('#LogButton').catch(() => {});
        await sleep(3500); await clearOKs();
        await page.goto(data.detail_url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(1500); await clearOKs(1);
      }
      fjDocUrl = await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find((x) => /^\s*final judgment\s*$/i.test((x.innerText || '').trim())); return a ? a.getAttribute('href') : null; }).catch(() => null);
    }
  }
  const r = await enrichAuctionCase({ page, county: COUNTY, caseNumber: CASE, fjDocUrl, capKey: env.CAPSOLVER_API_KEY, sb, owed, log: (...a) => console.error(...a), state: {} });
  const patch = { sale_date: r.sale_date, sale_location: r.sale_location, value_sheet_url: r.value_sheet_url, notice_of_sale_url: r.notice_of_sale_url, final_judgment_url: r.final_judgment_url, unpaid_principal: r.unpaid_principal, interest_owed: r.interest_owed, enriched_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  Object.keys(patch).forEach((k) => patch[k] == null && delete patch[k]);
  if (Object.keys(patch).length > 2) await sb.from('auction_leads').update(patch).eq('case_number', CASE);
  console.log(JSON.stringify({ case: CASE, county: COUNTY, ...r }));
} catch (e) {
  console.log(JSON.stringify({ case: CASE, error: String(e.message).slice(0, 160) }));
} finally { await ctx.close(); }
