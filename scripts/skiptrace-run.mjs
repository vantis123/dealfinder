// Batch skip-trace — runs LOCALLY (not on Railway yet). For each flagged door-knock lead not yet traced,
// look up the owner's phone numbers (TruePeopleSearch + FastPeopleSearch) and store them on the lead.
// Reuses one browser session across leads. Run: node scripts/skiptrace-run.mjs [--limit N] [--all] [--headed]
import { createClient } from '@supabase/supabase-js';
import { Camoufox } from 'camoufox-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from './_env.mjs';
import { traceWithPage } from './skiptrace.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const arg = k => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : null; };

const REDO = process.argv.includes('--all');
const LIMIT = parseInt(arg('limit') || '0', 10);

let q = sb.from('foreclosure_leads').select('case_number,defendant,property_address,spread')
  .eq('flagged', true).not('property_address', 'is', null).not('defendant', 'is', null)
  .order('spread', { ascending: false, nullsFirst: false });
if (!REDO) q = q.is('skip_traced_at', null);
if (LIMIT) q = q.limit(LIMIT);
const { data: leads, error } = await q;
if (error) { console.log('query failed:', error.message); process.exit(1); }
if (!leads?.length) { log('no flagged leads to skip-trace (use --all to re-trace)'); process.exit(0); }

log(`skip-tracing ${leads.length} door-knock lead(s)…`);
const ctx = await Camoufox({ headless: !process.argv.includes('--headed'), user_data_dir: join(tmpdir(), `camou-skiprun-${process.pid}`) });
const p = ctx.pages()[0] || await ctx.newPage();
let hit = 0;
try {
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    let r;
    try { r = await traceWithPage(p, l.defendant, l.property_address); }
    catch (e) { r = { matched: null, phones: [] }; log(`  ${l.case_number} error:`, String(e.message).slice(0, 50)); }
    await sb.from('foreclosure_leads').update({
      phones: r.phones || [], skiptrace_name: r.matched || null, skip_traced_at: new Date().toISOString(),
    }).eq('case_number', l.case_number);
    if (r.phones?.length) hit++;
    log(`  ${i + 1}/${leads.length} ${l.case_number} | ${l.defendant} → ${r.matched || 'no match'} | ${(r.phones || []).map(x => x.phone).join(', ') || 'no phones'}`);
  }
} finally { await ctx.close().catch(() => {}); }
log(`done — ${hit}/${leads.length} leads got phone numbers`);
process.exit(0);
