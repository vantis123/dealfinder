// Migration: add skip-trace columns to auction_leads (mirrors foreclosure_leads' phones/skiptrace_name/
// skip_traced_at, added originally for door-knock leads). Auction leads have no owner-name column —
// skiptrace-run.mjs traces them address-only (see scripts/skiptrace-run.mjs).
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';
const env = loadEnv(join(dirname(fileURLToPath(import.meta.url)), '..'));
const c = new pg.Client({ connectionString: env.SUPABASE_DB_POOL_URL || env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const cols = [
  ['phones', 'jsonb'],
  ['skiptrace_name', 'text'],
  ['skip_traced_at', 'timestamptz'],
];
for (const [name, type] of cols) {
  await c.query(`ALTER TABLE auction_leads ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  console.log('  + ' + name);
}
const { rows } = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='auction_leads' ORDER BY ordinal_position`);
console.log('auction_leads columns now:', rows.map(r => r.column_name).join(', '));
await c.end();
