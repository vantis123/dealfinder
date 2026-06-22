// Value every lead's property via Apify's Zillow Detail Scraper (rotating proxies — no IP blocking),
// recompute spread + worth-it, update Supabase, sync the sheet, and write the door-knock CSV.
// Run on its own (node scripts/value-with-apify.mjs) or automatically at the end of run-month.mjs.
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(`${ROOT}/.env`, 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const APIFY = env.APIFY_API_TOKEN;
const SHEET = env.SHEET_WEBHOOK_URL || '';
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const syncToSheet = async r => { if (!SHEET) return; try { await fetch(SHEET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseNumber: r.case_number, plaintiff: r.plaintiff, defendant: r.defendant, type: r.type, address: r.property_address || '', owed: r.owed_with_buffer || '', zillow: r.zillow_value || '', spread: r.spread || '', knock: r.flagged ? 'KNOCK' : (r.review_status === 'manual_review' ? 'REVIEW' : ''), complaint: r.complaint_url ? 'link' : 'X', value: r.value_url ? 'link' : 'X', status: r.review_status, county: r.county || 'Orange' }) }); } catch (e) {} };

if (!APIFY) { console.log('APIFY_API_TOKEN missing in .env — skipping valuation'); process.exit(0); }

const c = new pg.Client({ connectionString: env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const ONLY_MISSING = process.env.ALL !== '1';
const { rows } = await c.query(`select case_number, property_address, owed_with_buffer from foreclosure_leads where property_address is not null ${ONLY_MISSING ? 'and zillow_value is null' : ''}`);
console.log(`valuing ${rows.length} addresses via Apify…`);

if (rows.length) {
  const addresses = rows.map(r => r.property_address);
  const start = await fetch(`https://api.apify.com/v2/acts/maxcopell~zillow-detail-scraper/runs?token=${APIFY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses }) }).then(r => r.json());
  const runId = start.data?.id, datasetId = start.data?.defaultDatasetId;
  let status = 'RUNNING';
  for (let i = 0; i < 180 && (status === 'RUNNING' || status === 'READY'); i++) {
    await sleep(5000);
    status = (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`).then(r => r.json())).data?.status;
    if (i % 4 === 0) console.log('  apify:', status);
    if (['SUCCEEDED', 'FAILED', 'ABORTED'].includes(status)) break;
  }
  const items = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY}&fields=addressOrUrlFromInput,streetAddress,zestimate,price,taxAssessedValue`).then(r => r.json());
  const byInput = new Map(), byStreet = new Map();
  for (const it of items) { const v = it.zestimate || it.price || it.taxAssessedValue || null; if (it.addressOrUrlFromInput) byInput.set(norm(it.addressOrUrlFromInput), v); if (it.streetAddress) byStreet.set(norm(it.streetAddress), v); }
  console.log(`got ${items.length} Zillow results`);
  let valued = 0, worth = 0;
  for (const r of rows) {
    let z = byInput.get(norm(r.property_address));
    if (z == null) z = byStreet.get(norm(r.property_address.split(',')[0]));
    if (z == null) continue;
    valued++;
    const owed = Number(r.owed_with_buffer) || 0;
    const spread = owed ? z - owed : null;
    const flagged = spread != null ? spread >= 200000 : null;
    if (flagged) worth++;
    const patch = { zillow_value: z, spread, flagged, updated_at: new Date().toISOString() };
    if (flagged) { patch.review_status = 'auto'; patch.review_reason = null; }
    await sb.from('foreclosure_leads').update(patch).eq('case_number', r.case_number);
    await syncToSheet({ ...r, zillow_value: z, spread, flagged, review_status: flagged ? 'auto' : undefined });
  }
  console.log(`valued ${valued}/${rows.length} | WORTH-IT (spread ≥ $200k): ${worth}`);
}

// write the authoritative door-knock CSV from Supabase (worth-it first)
const { data: all } = await sb.from('foreclosure_leads').select('*').order('flagged', { ascending: false, nullsFirst: false }).order('spread', { ascending: false, nullsFirst: false });
const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
const head = ['Case Number', 'Plaintiff (Bank)', 'Defendant (Owner)', 'Filing Type', 'Property Address', 'Owed +$10K', 'Zillow Value', 'Spread', 'Knock?', 'Complaint Link', 'Value Link', 'Docket Link', 'Status'];
const lines = [head.map(esc).join(',')];
for (const r of all || []) lines.push([r.case_number, r.plaintiff, r.defendant, r.type, r.property_address || '', r.owed_with_buffer || '', r.zillow_value || '', r.spread || '', r.flagged ? 'KNOCK' : (r.review_status === 'manual_review' ? 'REVIEW' : ''), r.complaint_url || '', r.value_url || '', r.docket_url || '', r.review_status].map(esc).join(','));
writeFileSync(join(ROOT, 'door-knock-leads.csv'), lines.join('\n'));
console.log(`wrote door-knock-leads.csv (${(all || []).length} rows)`);
await c.end();
process.exit(0);
