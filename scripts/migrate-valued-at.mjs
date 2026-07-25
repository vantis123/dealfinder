// Migration: add valued_at (when the Zillow value was fetched) to auction_leads — drives the
// valuation cache so Apify only re-values stale/missing addresses instead of everything daily.
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';
const env = loadEnv(join(dirname(fileURLToPath(import.meta.url)), '..'));
const c = new pg.Client({ connectionString: env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query(`ALTER TABLE auction_leads ADD COLUMN IF NOT EXISTS valued_at timestamptz`);
// backfill: anything that already has a zillow value counts as valued "now" (starts the TTL clock)
const { rowCount } = await c.query(`UPDATE auction_leads SET valued_at = COALESCE(valued_at, updated_at, now()) WHERE zillow_value IS NOT NULL AND valued_at IS NULL`);
console.log(`+ valued_at added; backfilled ${rowCount} row(s)`);
await c.end();
