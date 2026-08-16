// Normalize the raw source tables (foreclosure_leads, auction_leads) into the unified `deals`
// spine the CRM reads. Idempotent upsert + derive stage from status + flag cross-source duplicates.
// Run at the end of the daily cron (daily.mjs) and standalone: node scripts/normalize-deals.mjs
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';
import { SQL_HOA } from './_disqualify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = loadEnv(join(__dirname, '..'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[normalize]', ...a);

// Prefer the IPv4 pooler (Railway has no IPv6 egress; Supabase's direct host is IPv6-only → ENETUNREACH).
const c = new pg.Client({ connectionString: env.SUPABASE_DB_POOL_URL || env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false }, keepAlive: true, statement_timeout: 60000 });
await c.connect();

await c.query(`CREATE TABLE IF NOT EXISTS deals (
  id text PRIMARY KEY, source_type text NOT NULL, source_ref text NOT NULL,
  county text, property_address text, lat numeric, lng numeric,
  value numeric, owed numeric, spread numeric,
  stage text, status text, flagged boolean, auction_date text,
  phones text, skiptrace_name text, ghl_contact_id text,
  buyer_id text, offer numeric, assignment_fee numeric,
  duplicate boolean DEFAULT false, dup_group text,
  notes text, knock_note text, source_url text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE(source_type, source_ref)
);`);

// NOTE: do NOT overwrite stage/status on conflict — those are driven by the human/agent in the CRM.
// Stage is only set on first INSERT (derived below); later runs just refresh the underlying data.
const onconf = `ON CONFLICT (id) DO UPDATE SET flagged=EXCLUDED.flagged,value=EXCLUDED.value,owed=EXCLUDED.owed,spread=EXCLUDED.spread,property_address=EXCLUDED.property_address,updated_at=now()`;

const pre = await c.query(`INSERT INTO deals (id,source_type,source_ref,county,property_address,value,owed,spread,stage,status,flagged,phones,skiptrace_name,knock_note,source_url)
SELECT 'preforeclosure:'||case_number,'preforeclosure',case_number,county,property_address,zillow_value,COALESCE(owed_with_buffer,total_owed),spread,
 CASE WHEN review_status='manual_review' THEN 'Review'
      WHEN knock_status='to_knock' THEN 'To Knock' WHEN knock_status='no_answer' THEN 'No Answer'
      WHEN knock_status='talked' THEN 'Talked' WHEN knock_status='interested' THEN 'Interested'
      WHEN knock_status='follow_up' THEN 'Follow Up' WHEN knock_status='not_interested' THEN 'Dead'
      WHEN knock_status='deal' THEN 'Under Contract' ELSE 'New' END,
 COALESCE(knock_status,review_status,'new'),flagged,phones,skiptrace_name,knock_note,COALESCE(docket_url,complaint_url)
FROM foreclosure_leads WHERE property_address IS NOT NULL AND btrim(property_address) <> ''
  AND NOT ${SQL_HOA} ${onconf},phones=EXCLUDED.phones`);

const auc = await c.query(`INSERT INTO deals (id,source_type,source_ref,county,property_address,value,owed,spread,stage,status,flagged,auction_date,knock_note,source_url)
SELECT 'auction:'||case_number,'auction',case_number,county,property_address,COALESCE(value_used,zillow_value),final_judgment,spread,
 CASE WHEN knock_status='interested' THEN 'Interested' WHEN knock_status='talked' THEN 'Talked' WHEN knock_status='deal' THEN 'Under Contract'
      WHEN lower(COALESCE(auction_status,'')) ~ 'cancel|bankruptc' THEN 'Cancelled'
      WHEN lower(COALESCE(auction_status,'')) ~ 'sold' THEN 'Sold'
      WHEN lower(COALESCE(auction_status,'')) ~ 'reschedul' THEN 'Rescheduled' ELSE 'New' END,
 COALESCE(auction_status,'Scheduled'),flagged,COALESCE(sale_date,auction_date),knock_note,COALESCE(final_judgment_url,value_sheet_url,detail_url)
FROM auction_leads WHERE property_address IS NOT NULL AND btrim(property_address) <> '' ${onconf}`);

// No real address = not actionable = not in the CRM. Purge any address-less deals (incl. ones promoted before this rule).
// DELETE ON THE REASON, NOT ON THE SYMPTOM (Phillip 2026-08-15).
// "No address" has two opposite causes and this rule used to treat them identically:
//   (a) THERE IS NO DOOR — HOA/association lien, timeshare interest, government plaintiff,
//       case not found. Not a deal. Deleting is correct and keeps the CRM honest.
//   (b) WE FAILED TO READ IT — the clerk site timed out, the complaint never downloaded, the
//       parser missed. That is a lead we paid to find, thrown away.
// Measured across Orange/Seminole/Lake/Volusia on 2026-08-15: of 311 address-less leads only
// 38 had no door. 273 — 88% — were ours to recover, and the two biggest buckets (245) were
// documents we never even fetched.
// Deleting those is also what made the 2026-07-14 -> 08-11 outage invisible: the failures were
// removed, so the screen stayed clean while 70% of the pipeline vanished. A retry queue that
// grows is a symptom you can SEE.
const NO_DOOR = `review_reason ~* '(hoa|assoc|timeshare|gov_plaintiff|case_not_found)'`;
const purged = await c.query(`DELETE FROM deals d
  WHERE (d.property_address IS NULL OR btrim(d.property_address) = '')
    AND d.source_type = 'preforeclosure'
    AND EXISTS (SELECT 1 FROM foreclosure_leads f WHERE f.case_number = d.source_ref AND ${NO_DOOR})`);
// Auctions carry no review_reason; an address-less auction row is unusable either way.
const purgedAuction = await c.query(`DELETE FROM deals WHERE source_type='auction' AND (property_address IS NULL OR btrim(property_address) = '')`);
// Everything else with no address STAYS, flagged for retry, and is counted so it is visible.
const { rows: [kept] } = await c.query(`SELECT count(*)::int AS n FROM foreclosure_leads
  WHERE (property_address IS NULL OR btrim(property_address) = '') AND NOT (${NO_DOOR}) OR (review_reason IS NULL AND (property_address IS NULL OR btrim(property_address)=''))`);

// Same treatment for HOA/association plaintiffs — 2nd-position liens, never a door-knock.
// This is the CENTRAL guard: the per-county scrapers each apply their own filter and they
// drifted (Orange dropped them, Seminole/Osceola/Polk/Lake let them through). Enforcing it
// here means a leaky scraper can never put an HOA case in front of anyone. Source rows stay
// in foreclosure_leads as history; they just never become deals.
const hoaPurged = await c.query(`DELETE FROM deals WHERE source_type='preforeclosure'
  AND source_ref IN (SELECT case_number FROM foreclosure_leads WHERE ${SQL_HOA})`);

await c.query(`UPDATE deals SET duplicate=false, dup_group=NULL WHERE duplicate`);
const dup = await c.query(`WITH norm AS (SELECT id, lower(regexp_replace(COALESCE(property_address,''),'[^a-z0-9]','','g')) k, source_type FROM deals WHERE property_address IS NOT NULL),
 dups AS (SELECT k FROM norm GROUP BY k HAVING count(DISTINCT source_type)>1 AND k<>'')
 UPDATE deals d SET duplicate=true, dup_group=n.k FROM norm n JOIN dups ON n.k=dups.k WHERE d.id=n.id`);

log(`deals synced — preforeclosure ${pre.rowCount}, auction ${auc.rowCount}, purged(no-door) ${purged.rowCount + purgedAuction.rowCount}, KEPT for retry ${kept.n}, purged(HOA) ${hoaPurged.rowCount}, duplicates ${dup.rowCount}`);
await c.end();
