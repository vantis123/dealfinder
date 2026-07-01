// Backfill filing_date for existing leads by reading the complaint PDF already in Supabase Storage
// (the "E-Filed MM/DD/YYYY" stamp). No re-scrape. Run: node scripts/backfill-filing-dates.mjs [--all]
//   default = flagged (door-knock) leads only;  --all = every lead with a saved complaint.
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function filingDate(file) {
  try {
    const t = execFileSync('pdftotext', ['-l', '1', file, '-'], { maxBuffer: 5e7 }).toString();
    const m = t.match(/E-?Filed:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i) || t.match(/\bFiled:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    return m ? `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : null;
  } catch (e) { return null; }
}

const ALL = process.argv.includes('--all');
let q = sb.from('foreclosure_leads').select('case_number,complaint_url').like('complaint_url', '%/storage/%').is('filing_date', null);
if (!ALL) q = q.eq('flagged', true);
const { data: leads, error } = await q;
if (error) { console.log('query failed:', error.message); process.exit(1); }
if (!leads?.length) { log('nothing to backfill'); process.exit(0); }

log(`backfilling filing_date for ${leads.length} lead(s)…`);
let hit = 0;
for (const l of leads) {
  try {
    const buf = Buffer.from(await (await fetch(l.complaint_url)).arrayBuffer());
    const f = join(tmpdir(), `fd-${l.case_number.replace(/[^A-Za-z0-9]/g, '_')}.pdf`);
    writeFileSync(f, buf);
    const fd = filingDate(f);
    try { unlinkSync(f); } catch (e) {}
    if (fd) { await sb.from('foreclosure_leads').update({ filing_date: fd }).eq('case_number', l.case_number); hit++; }
    log(`  ${l.case_number}: ${fd || 'no E-Filed stamp found'}`);
  } catch (e) { log(`  ${l.case_number} error:`, String(e.message).slice(0, 40)); }
}
log(`done — ${hit}/${leads.length} got a filing date`);
process.exit(0);
