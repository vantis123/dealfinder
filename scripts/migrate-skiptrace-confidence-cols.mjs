// Migration: add name-match confidence columns to foreclosure_leads (+ auction_leads for
// consistency), added when skiptrace.mjs/skiptrace-run.mjs stopped trusting address-only fallback
// matches as the real owner (see scripts/skiptrace.mjs traceWithPage). `phones` now only ever holds
// a NAME-MATCHED number for preforeclosure leads; an address-only candidate (no name agreement)
// lands in low_confidence_phones instead, flagged for human review — never auto-eligible for an
// SMS funnel. `not_a_person` marks defendants that are banks/LLCs/"UNKNOWN..."/legal boilerplate —
// there's no homeowner name to match, so these are skipped (not traced) rather than mismatched.
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';
const env = loadEnv(join(dirname(fileURLToPath(import.meta.url)), '..'));
const c = new pg.Client({ connectionString: env.SUPABASE_DB_POOL_URL || env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const cols = [
  ['not_a_person', 'boolean'],
  ['low_confidence', 'boolean'],
  ['low_confidence_phones', 'jsonb'],
  ['low_confidence_name', 'text'],
];
for (const table of ['foreclosure_leads', 'auction_leads']) {
  for (const [name, type] of cols) {
    await c.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    console.log(`  + ${table}.${name}`);
  }
}
await c.query(`CREATE INDEX IF NOT EXISTS idx_fl_not_a_person ON foreclosure_leads (not_a_person)`);
console.log('done.');
await c.end();
