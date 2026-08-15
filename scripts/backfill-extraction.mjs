// Re-run the extraction ladder over leads that are missing an address and/or `owed`, using the
// documents ALREADY in Supabase Storage. No scraping, no clerk hits — pure re-parse.
//
// WHY: from 2026-07-14 to 2026-08-11 the address path had no OCR and no working AI, so 559 of 803
// pre-foreclosure leads were saved with no address and then dropped before the CRM by
// normalize-deals.mjs. Those documents are still in storage — the leads are recoverable offline.
//
// Usage:
//   node scripts/backfill-extraction.mjs                 # DRY RUN (default) — writes nothing
//   node scripts/backfill-extraction.mjs --apply         # actually update Supabase
//   node scripts/backfill-extraction.mjs --apply --limit 50 --county Lake
//   node scripts/backfill-extraction.mjs --apply --no-ai  # free tiers only (no subscription usage)
//
// Safety:
//   * only ever FILLS blanks — never overwrites an address or an owed value that already exists
//   * writes only `accepted` addresses (high/medium confidence); low-confidence guesses are
//     reported and left for review, never written
//   * re-runnable; skips anything already resolved

import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';
import { extractAddress, extractOwed, aiStats } from './_extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const APPLY = has('--apply');
const USE_AI = !has('--no-ai');
const LIMIT = parseInt(val('--limit', '0'), 10);
const COUNTY = val('--county', null);
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'no-key' });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const c = new pg.Client({ connectionString: env.SUPABASE_DB_POOL_URL || env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();

const where = [`(
   ((property_address IS NULL OR btrim(property_address)='') AND (complaint_url LIKE '%supabase%' OR lis_pendens_url LIKE '%supabase%'))
   OR (total_owed IS NULL AND value_url LIKE '%supabase%')
 )`];
if (COUNTY) where.push(`county = '${COUNTY.replace(/'/g, "''")}'`);
const { rows } = await c.query(`
  SELECT case_number, county, property_address, total_owed, complaint_url, value_url, lis_pendens_url
  FROM foreclosure_leads WHERE ${where.join(' AND ')}
  ORDER BY scanned_at DESC NULLS LAST ${LIMIT ? `LIMIT ${LIMIT}` : ''}`);

log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing will be written — pass --apply to commit)'}`);
log(`AI tiers: ${USE_AI ? 'ON (subscription first, metered key as fallback)' : 'OFF (free tiers only)'}`);
log(`${rows.length} lead(s) to re-parse${COUNTY ? ` in ${COUNTY}` : ''}\n`);

const fetchTmp = async (url, tag) => {
  const f = join(tmpdir(), `bf-${tag}-${Math.random().toString(36).slice(2, 9)}.pdf`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`http ${r.status}`);
  writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
};

const stat = { seen: 0, addr: 0, held: 0, owed: 0, err: 0, byCounty: {} };
const heldList = [];

for (const L of rows) {
  stat.seen++;
  const B = (stat.byCounty[L.county] ||= { n: 0, addr: 0, owed: 0 });
  B.n++;
  const set = {};
  let note = [];

  // ── address ──────────────────────────────────────────────────────────────────
  if (!L.property_address || !String(L.property_address).trim()) {
    // Polk's address lives in the Lis Pendens, everyone else's in the complaint.
    const src = L.lis_pendens_url?.includes('supabase') ? L.lis_pendens_url : L.complaint_url;
    if (src?.includes('supabase')) {
      let f = null;
      try {
        f = await fetchTmp(src, 'a');
        const r = await extractAddress(f, { county: L.county, useAI: USE_AI, anthropic });
        if (r.accepted) { set.property_address = r.accepted; stat.addr++; B.addr++; note.push(`addr=${r.accepted} [${r.tier}]`); }
        else if (r.address) { stat.held++; heldList.push({ case: L.case_number, county: L.county, guess: r.address }); note.push(`HELD ${r.address}`); }
        else note.push('addr: none');
      } catch (e) { stat.err++; note.push(`addr ERR ${String(e.message).slice(0, 40)}`); }
      finally { if (f) try { unlinkSync(f); } catch (e) {} }
    }
  }

  // ── owed (drives spread, which drives flagging) ──────────────────────────────
  if (L.total_owed == null && L.value_url?.includes('supabase')) {
    let f = null;
    try {
      f = await fetchTmp(L.value_url, 'v');
      const o = await extractOwed(f, { useAI: USE_AI, anthropic });
      if (o.principalDue != null || o.interestOwed != null) {
        const tot = (o.principalDue || 0) + (o.interestOwed || 0);
        if (tot > 0) {
          set.principal_due = o.principalDue ?? null;
          set.interest_owed = o.interestOwed ?? null;
          set.total_owed = tot;
          set.owed_with_buffer = tot + 10000;
          stat.owed++; B.owed++; note.push(`owed=${tot} [${o.tier}]`);
        }
      } else note.push('owed: none');
    } catch (e) { stat.err++; note.push(`owed ERR ${String(e.message).slice(0, 40)}`); }
    finally { if (f) try { unlinkSync(f); } catch (e) {} }
  }

  if (Object.keys(set).length) {
    if (APPLY) {
      // COALESCE guard: only ever fill a blank, never clobber an existing value.
      const cols = Object.keys(set);
      const sets = cols.map((k, i) => `${k} = COALESCE(${k}, $${i + 1})`).join(', ');
      await c.query(
        `UPDATE foreclosure_leads SET ${sets}, updated_at = now() WHERE case_number = $${cols.length + 1}`,
        [...cols.map(k => set[k]), L.case_number]
      );
    }
    log(`  ${L.county.padEnd(9)} ${L.case_number.padEnd(26)} ${note.join(' | ')}`);
  } else if (note.length) {
    log(`  ${L.county.padEnd(9)} ${L.case_number.padEnd(26)} ${note.join(' | ')}`);
  }
}

console.log('\n──────── SUMMARY ────────');
console.log(`leads examined : ${stat.seen}`);
console.log(`addresses found: ${stat.addr}`);
console.log(`held for review: ${stat.held}  (low confidence — NOT written)`);
console.log(`owed recovered : ${stat.owed}`);
console.log(`errors         : ${stat.err}`);
console.log(`AI: sub ok=${aiStats.subOk} fail=${aiStats.subFail} · api ok=${aiStats.apiOk} fail=${aiStats.apiFail}`);
if (aiStats.lastSubError) console.log(`last subscription error: ${aiStats.lastSubError}`);
console.table(Object.entries(stat.byCounty).map(([county, v]) => ({ county, examined: v.n, addresses: v.addr, owed: v.owed })));
if (heldList.length) {
  console.log('\nHeld for review (low confidence, nothing written):');
  for (const h of heldList.slice(0, 25)) console.log(`  ${h.county.padEnd(9)} ${h.case.padEnd(26)} ${h.guess}`);
  if (heldList.length > 25) console.log(`  …and ${heldList.length - 25} more`);
}
if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
else console.log('\nApplied. Run `node scripts/normalize-deals.mjs` to push recovered leads into the CRM.');
await c.end();
