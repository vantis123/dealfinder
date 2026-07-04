// Migration: add clerk/comptroller enrichment columns to auction_leads.
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';
const env = loadEnv(join(dirname(fileURLToPath(import.meta.url)), '..'));
const c = new pg.Client({ connectionString: env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const cols = [
  ['sale_date', 'text'], ['sale_location', 'text'],
  ['value_sheet_url', 'text'], ['notice_of_sale_url', 'text'], ['final_judgment_url', 'text'],
  ['unpaid_principal', 'numeric'], ['interest_owed', 'numeric'], ['enriched_at', 'timestamptz'],
];
for (const [name, type] of cols) {
  await c.query(`ALTER TABLE auction_leads ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  console.log('  + ' + name);
}
const { rows } = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='auction_leads' ORDER BY ordinal_position`);
console.log('auction_leads columns now:', rows.map(r => r.column_name).join(', '));
await c.end();
