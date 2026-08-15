// Re-mint expired Supabase Storage signed URLs for foreclosure documents.
//
// WHY: _storage.mjs signs with a 30-day TTL, so any document stored more than 30 days ago now has a
// dead link — `http 400` on fetch. The FILE is still in the bucket; only the signature aged out.
// This surfaced during the 2026-08-11 backfill: 24 of 261 leads could not be re-parsed for exactly
// this reason, and it will keep happening to every document as it crosses 30 days.
//
// The object path is deterministic (`<case>/<kind>.pdf`), so a fresh URL can always be minted
// without the old one. createSignedUrl() fails if the object genuinely isn't there, which also makes
// this a cheap audit of what is actually stored.
//
// Usage:
//   node scripts/resign-doc-urls.mjs            # DRY RUN — reports what would be re-signed
//   node scripts/resign-doc-urls.mjs --apply
//
// NOTE (deferred, per the comment in _storage.mjs): the real fix is to store the PATH in the DB and
// mint a short-TTL URL on demand per view. Until then this needs re-running periodically.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const APPLY = process.argv.includes('--apply');
const BUCKET = 'foreclosure-docs';
const TTL = 60 * 60 * 24 * 30;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const c = new pg.Client({ connectionString: env.SUPABASE_DB_POOL_URL || env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();

const { rows } = await c.query(`
  SELECT case_number, complaint_url, value_url, lis_pendens_url
  FROM foreclosure_leads
  WHERE complaint_url LIKE '%supabase%' OR value_url LIKE '%supabase%' OR lis_pendens_url LIKE '%supabase%'`);

log(`${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'} — checking ${rows.length} lead(s)\n`);

const KINDS = [['complaint', 'complaint_url'], ['value', 'value_url'], ['lispendens', 'lis_pendens_url']];
const stat = { checked: 0, alive: 0, resigned: 0, missing: 0 };

for (const L of rows) {
  const safe = String(L.case_number).replace(/[^A-Za-z0-9._-]/g, '_');
  const set = {};
  for (const [kind, col] of KINDS) {
    const cur = L[col];
    if (!cur || !cur.includes('supabase')) continue;
    stat.checked++;
    // Is the current signature still good?
    let ok = false;
    try { const r = await fetch(cur, { method: 'GET', headers: { Range: 'bytes=0-0' } }); ok = r.ok; } catch (e) { ok = false; }
    if (ok) { stat.alive++; continue; }
    // Dead signature — re-mint from the deterministic path.
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(`${safe}/${kind}.pdf`, TTL);
    if (error || !data?.signedUrl) { stat.missing++; log(`  ${L.case_number.padEnd(26)} ${kind}: object MISSING from bucket`); continue; }
    set[col] = data.signedUrl;
    stat.resigned++;
    log(`  ${L.case_number.padEnd(26)} ${kind}: re-signed`);
  }
  if (APPLY && Object.keys(set).length) {
    const cols = Object.keys(set);
    await c.query(
      `UPDATE foreclosure_leads SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE case_number = $${cols.length + 1}`,
      [...cols.map(k => set[k]), L.case_number]
    );
  }
}

console.log('\n──────── SUMMARY ────────');
console.log(`documents checked : ${stat.checked}`);
console.log(`still valid       : ${stat.alive}`);
console.log(`re-signed         : ${stat.resigned}`);
console.log(`missing from bucket: ${stat.missing}`);
if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.');
await c.end();
