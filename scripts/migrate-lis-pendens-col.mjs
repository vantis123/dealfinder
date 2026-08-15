// Adds foreclosure_leads.lis_pendens_url — Polk's ACTUAL address source.
// Polk's complaint is public page-1 only, so the address comes from the Lis Pendens; that document
// was previously read and deleted, which is why Polk's 98% no-address rate was undiagnosable from
// storage (0 of 25 stored Polk docs contained an address at all). Keeping it makes Polk auditable
// and backfillable. Run once: node scripts/migrate-lis-pendens-col.mjs
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';
const env = loadEnv(join(dirname(fileURLToPath(import.meta.url)), '..'));
const c = new pg.Client({ connectionString: env.SUPABASE_DB_POOL_URL || env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query(`ALTER TABLE foreclosure_leads ADD COLUMN IF NOT EXISTS lis_pendens_url text`);
const { rows } = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='foreclosure_leads' AND column_name='lis_pendens_url'`);
console.log(rows.length ? '✅ lis_pendens_url present' : '❌ column missing');
await c.end();
