// One-time: create the foreclosure_leads table in your Supabase project. Run: node scripts/db-setup.mjs
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(`${ROOT}/.env`, 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
if (!env.DIRECT_URL) { console.error('DIRECT_URL missing in .env'); process.exit(1); }
const c = new pg.Client({ connectionString: env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
try {
  await c.connect();
  await c.query(`create table if not exists foreclosure_leads(
    case_number text primary key, county text default 'Orange',
    plaintiff text, defendant text, type text, property_address text,
    principal_due numeric, interest_owed numeric, total_owed numeric, owed_with_buffer numeric,
    zillow_value numeric, spread numeric, flagged boolean,
    review_status text, review_reason text,
    complaint_url text, value_url text, docket_url text,
    knock_status text default 'new', knock_note text,
    scan_month int, scan_year int,
    scanned_at timestamptz default now(), updated_at timestamptz default now())`);
  const { rows } = await c.query('select count(*) from foreclosure_leads');
  console.log('✓ foreclosure_leads table ready (rows:', rows[0].count + ')');
} catch (e) { console.error('DB setup failed:', e.message); process.exit(1); }
finally { await c.end().catch(() => {}); }
