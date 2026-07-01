// One-time: create the foreclosure_leads table in your Supabase project. Run: node scripts/db-setup.mjs
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';
import { ensureBucket } from './_storage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT); // .env locally, process.env on Railway/containers
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
    notified_at timestamptz,
    scanned_at timestamptz default now(), updated_at timestamptz default now())`);
  // Backfill the column on tables created before the Telegram report existed.
  await c.query('alter table foreclosure_leads add column if not exists notified_at timestamptz');
  // Skip-trace results (owner phone numbers from TruePeopleSearch / FastPeopleSearch).
  await c.query('alter table foreclosure_leads add column if not exists phones jsonb');
  await c.query('alter table foreclosure_leads add column if not exists skiptrace_name text');
  await c.query('alter table foreclosure_leads add column if not exists skip_traced_at timestamptz');
  // Court filing date (from the complaint's "E-Filed" stamp) — for sorting by how fresh the filing is.
  await c.query('alter table foreclosure_leads add column if not exists filing_date date');
  await c.query('create index if not exists idx_fl_filing on foreclosure_leads (filing_date desc)');
  // Performance indexes (identical to db/schema.sql so both setup paths produce the same database).
  await c.query('create index if not exists idx_fl_flagged  on foreclosure_leads (flagged)');
  await c.query('create index if not exists idx_fl_county   on foreclosure_leads (county)');
  await c.query('create index if not exists idx_fl_scan     on foreclosure_leads (scan_year, scan_month)');
  await c.query('create index if not exists idx_fl_spread   on foreclosure_leads (spread desc)');
  await c.query('create index if not exists idx_fl_notified on foreclosure_leads (notified_at)');
  const { rows } = await c.query('select count(*) from foreclosure_leads');
  console.log('✓ foreclosure_leads table + indexes ready (rows:', rows[0].count + ')');
  // Storage bucket for saved Complaint/Value PDFs (so they outlive the county site's link expiry).
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const r = await ensureBucket(sb);
    console.log(r.ok ? '✓ foreclosure-docs storage bucket ready' : '⚠ bucket: ' + r.msg);
  }
} catch (e) { console.error('DB setup failed:', e.message); process.exit(1); }
finally { await c.end().catch(() => {}); }
