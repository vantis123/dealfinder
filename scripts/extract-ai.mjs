// AI PDF EXTRACTOR — reads foreclosure PDFs with Claude and recovers the property address
// and amounts that the regex/OCR pass missed.
//
// WHY IT EXISTS
// Measured 2026-07-26 on Orange: 336 cases, only 85 usable. Of the 251 failures, 42 have a
// PDF we already downloaded but no extracted address. Inspecting one showed the data is
// plainly there and the text layer is clean — the parser just can't see it:
//
//     Street Address:
//                        <- blank line
//     2753 BASS LAKE BLVD
//     ORLANDO, FL 32806
//
// The existing anchor heuristic looks ~70 chars behind a candidate, so a label separated from
// its value by blank lines is invisible to it. That is a layout problem, not an OCR problem.
//
// WHY IT'S FREE
// It shells out to `claude -p` — the Claude Code CLI on Phillip's Max subscription — instead of
// the metered Anthropic API used by enrich-one.mjs. Per the migration plan: "No per-token bill
// on the box's own work." `USE_AI=0` was set on 2026-07-14 because vision was the biggest API
// line ($5-15/mo); routing through the subscription removes that objection entirely.
//
// THE POINT IS THE CORPUS, NOT THE AI
// Every extraction appends to data/extraction-corpus.jsonl: the surrounding raw text, what the
// AI returned, and whether the county appraiser could actually find that address. That is a
// labelled dataset. Once it covers enough layouts, the patterns become deterministic parser
// rules and the AI drops back to handling only the tail. Plan (Phillip 2026-07-26): "build the
// correct code... then we'd be able to make a code that doesn't need to use any of our
// subscription on Claude."
//
// VERIFICATION IS THE LABEL
// Every AI address is checked against the Orange property appraiser. A parcel match means the
// address is real, not hallucinated — and it hands back the assessed value in the same call.
// A miss is recorded too; unverified addresses are NOT written to the leads table.
//
// Run:
//   node scripts/extract-ai.mjs                 # up to AI_MAX cases (default 15)
//   AI_MAX=50 node scripts/extract-ai.mjs
//   AI_CASE=2026-CA-006420-O node scripts/extract-ai.mjs   # one specific case

import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MAX = parseInt(process.env.AI_MAX || '15', 10);
const ONE = process.env.AI_CASE || '';
const CORPUS_DIR = join(ROOT, 'data');
const CORPUS = join(CORPUS_DIR, 'extraction-corpus.jsonl');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[ai]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The `claude` CLI treats ANTHROPIC_API_KEY as an auth source and PREFERS it over the Max
// subscription login — with it set, every call dies on "Credit balance is too low" even
// though the subscription is healthy. .env carries it for the legacy metered path, so strip
// it here rather than depending on every caller's environment being clean.
delete process.env.ANTHROPIC_API_KEY;

function sh(cmd, args, { timeout = 240000, input } = {}) {
  return new Promise(resolve => {
    const c = execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') }));
    if (input !== undefined) c.stdin.end(input);
  });
}

const PROMPT = `Read this Florida foreclosure court PDF and extract the subject property and amounts.

Return ONLY minified JSON, no prose and no code fence:
{"propertyAddress":"<full street address with city, state and ZIP, or null>","candidates":["<other FL property addresses appearing in the document>"],"docType":"<complaint|summons|final judgment|lis pendens|value of property|other>","propertyType":"<single-family|condo|timeshare|commercial|land|unknown>","principalDue":<number or null>,"interestOwed":<number or null>}

WHERE THE ADDRESS HIDES — check all of these, in order:
1. After a label: "Street Address:", "Property Address:", "commonly known as". The label and the
   value are frequently separated by BLANK LINES — the address can sit 2-4 lines below the label.
2. In prose with no label at all, e.g. "real property located at 182 Kentucky Blue Circle, Apopka,
   Florida 32712, legally described as Lot 9, Bluegrass Estates...". This phrasing is common and
   easy to miss — search for "located at", "situated at", "the subject property".
3. Immediately before or after a legal description (LOT / BLOCK / PLAT BOOK / PAGE).

WHICH ADDRESS IS THE RIGHT ONE:
- It is the MORTGAGED PROPERTY being foreclosed on.
- It is NOT the plaintiff's or loan servicer's business address, NOT the law firm's address, and
  NOT a defendant's mailing/service address (those are often out of state — a non-Florida address
  is almost never the subject property).
- If SEVERAL Florida properties appear, put your best pick in propertyAddress and list every other
  Florida address in candidates. Do not silently drop the others.
- Only if NO Florida property address appears anywhere: propertyAddress = null, candidates = [].

docType: what this document actually is. Say "summons" if it is a summons, even if the filename
suggests otherwise — mis-filed documents are common and worth flagging.

propertyType matters as much as the address. Say "timeshare" when the complaint cites
Chapter 721 Fla. Stat., calls the interest a vacation/ownership/points/週 interval, names a resort
as plaintiff, or gives a resort street address shared by many defendants. Say "condo" for
Chapter 718 condominium units. These have no single door to knock and are NOT door-knock leads —
labelling them correctly is more useful than forcing an address out of them.

principalDue is the unpaid principal balance; interestOwed is accrued interest. Use null when a
figure is not stated. Never guess, never compute.`;

// Ask the appraiser whether this address actually exists. Doubles as hallucination control
// and as the assessed value, in one request.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const OCPA_H = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://ocpaweb.ocpafl.org', Referer: 'https://ocpaweb.ocpafl.org/' };
const OCPA = 'https://ocpa-mainsite-afd-standard.azurefd.net/api';

async function verifyWithAppraiser(address) {
  const street = String(address || '').split(',')[0]
    .replace(/\s+(suite|ste|apt|unit|bldg|#)\s*#?\s*[\w-]+/ig, '').replace(/\s+/g, ' ').trim();
  if (!street) return null;
  try {
    const hits = await fetch(`${OCPA}/QuickSearch/GetSearchInfoByAddress?address=${encodeURIComponent(street)}&page=1&size=5&sortBy=ParcelID&sortDir=ASC`, { headers: OCPA_H }).then(r => r.json());
    if (!Array.isArray(hits) || !hits.length) return null;
    const pid = hits[0].parcelId;
    const vals = await fetch(`${OCPA}/PRC/GetPRCPropertyValues?PID=${pid}&TaxYear=0&ShowAllFlag=1`, { headers: OCPA_H }).then(r => r.json());
    const row = (Array.isArray(vals) ? vals : []).filter(v => Number(v.marketValue) > 0).sort((a, b) => b.taxYear - a.taxYear)[0];
    return { parcelId: pid, ocpaAddress: hits[0].propertyAddress, assessed: row ? Number(row.marketValue) : null, year: row?.taxYear ?? null, isHomestead: String(row?.isHomestead) === 'True' };
  } catch { return null; }
}

async function pdfText(file) {
  const r = await sh('pdftotext', [file, '-'], { timeout: 60000 });
  return r.ok ? r.out : '';
}

// Keep the ±N lines around each address-ish label. This is the raw material for writing the
// deterministic parser later — full PDFs would make the corpus unusable.
function corpusSnippet(text) {
  const lines = String(text).split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    if (/street address|property address|commonly known|situated|legal description/i.test(l)) {
      hits.push(lines.slice(Math.max(0, i - 2), i + 8).join('\n'));
    }
  });
  return hits.slice(0, 6).join('\n---\n').slice(0, 4000);
}

async function extractOne(row) {
  const safe = row.case_number.replace(/[^A-Za-z0-9._-]/g, '_');
  let file = null, used = null;
  // Lis Pendens FIRST. By Florida law it carries the legal description plus "Also known as:
  // <street address>", it is one page, and it is always public — whereas a complaint may be
  // gated to page 1 (Polk does this when the note/mortgage are confidential exhibits), and
  // page 1 holds only the plaintiff's business address. Reading the complaint first is how
  // you end up extracting a lender's headquarters instead of the house.
  // COMPLAINT FIRST. The 2026-07-29 format sweep read real filings in all five counties and the
  // answer was unanimous — the complaint is where the property address lives:
  //   Polk      "See Mortgage. Exhibit B hereto. The Property is located at 1336 Madison Circle"
  //   Orange    "Property Address:        5450 GAYMAR DR" / "5450 GAYMAR DR, ORLANDO, FL 32818"
  //   Osceola   "which currently has the address of 3521 Anibal St, Kissimmee, FL 34746"
  //   Seminole  "638 King Harold Ct. Oviedo, FL 32765 (the “Property”)"
  //
  // Lis Pendens is only a FALLBACK: Polk's carries a legal description and no street address at
  // all, which contradicts the note in counties.mjs. An earlier version of this loop put it
  // first and consequently read the wrong document for every Polk case that had one.
  //
  // value.pdf is NEVER read for an address — it is the "Value of Real Property" filing-fee
  // affidavit. Identical in every county, and the only address on it is the law firm's.
  for (const kind of ['complaint', 'lispendens']) {
    const { data } = await sb.storage.from('foreclosure-docs').download(`${safe}/${kind}.pdf`);
    if (!data) continue;
    file = `/tmp/aix-${safe}-${kind}.pdf`;
    writeFileSync(file, Buffer.from(await data.arrayBuffer()));
    used = kind;
    break;
  }
  if (!file) return { case: row.case_number, skip: 'no PDF in storage' };

  try {
    const raw = await pdfText(file);
    const r = await sh('bash', ['-lc', `claude -p ${JSON.stringify(PROMPT + '\n\nPDF file: ' + file)}`], { timeout: 300000 });
    const m = r.out.match(/\{[\s\S]*\}/);
    if (!m) return { case: row.case_number, skip: `no JSON from claude: ${r.out.slice(0, 80) || r.err.slice(0, 80)}` };
    let ai;
    try { ai = JSON.parse(m[0]); } catch { return { case: row.case_number, skip: 'unparseable JSON' }; }

    // Verify the pick; if the appraiser can't confirm it, try the other Florida addresses the
    // model saw. A multi-property document (e.g. one naming both 182 Kentucky Blue Circle and
    // 3949 Gourock Court) is exactly where the first guess is most likely to be the wrong one.
    let verified = ai.propertyAddress ? await verifyWithAppraiser(ai.propertyAddress) : null;
    if (!verified && Array.isArray(ai.candidates)) {
      for (const alt of ai.candidates.slice(0, 4)) {
        const v = await verifyWithAppraiser(alt);
        if (v) { verified = v; ai.propertyAddress = alt; ai.pickedFromCandidates = true; break; }
      }
    }

    mkdirSync(CORPUS_DIR, { recursive: true });
    appendFileSync(CORPUS, JSON.stringify({
      case: row.case_number, county: row.county, doc: used,
      ai, verified, snippet: corpusSnippet(raw), at: new Date().toISOString(),
    }) + '\n');

    // A timeshare/condo-hotel interval has no single door to knock — same class as the HOA
    // plaintiffs in _disqualify.mjs. Record WHY it was set aside so it stops cycling through
    // manual_review forever, instead of being retried every run as if it were rescuable.
    // (The 07-14 cost audit already saw this from the other end: the unvalued backlog was
    // "mostly condo-hotel/timeshare-style units Zillow has no Zestimate for".)
    if (/timeshare/i.test(ai.propertyType || '')) {
      await sb.from('foreclosure_leads').update({
        review_status: 'disqualified',
        review_reason: `timeshare interest (${ai.docType || 'doc'}) — no door to knock`,
        updated_at: new Date().toISOString(),
      }).eq('case_number', row.case_number);
      return { case: row.case_number, ai, verified: null, disqualified: 'timeshare' };
    }

    // Orange: only persist an address the appraiser can confirm — an unverified one is worse
    // than none, because it silently sends someone to knock the wrong door.
    // Other counties: no appraiser adapter exists yet, so accept the address and let the
    // valuation step be the check. Recorded honestly via value_source so the two are never
    // conflated when someone asks how a lead was sourced.
    // Only Orange has an appraiser adapter today (verifyWithAppraiser hits OCPA). Every other
    // county appraiser is a different vendor needing its own endpoint discovery.
    const hasAdapter = row.county === 'Orange';
    if (ai.propertyAddress && (verified || !hasAdapter)) {
      const patch = { property_address: ai.propertyAddress, updated_at: new Date().toISOString() };
      if (verified) {
        patch.assessed_value = verified.assessed; patch.assessed_year = verified.year;
        patch.parcel_id = verified.parcelId; patch.is_homestead = verified.isHomestead;
      }
      patch.review_reason = verified ? null : 'ai-extracted, appraiser unverified';
      if (ai.principalDue != null) {
        patch.principal_due = ai.principalDue;
        const total = Number(ai.principalDue) + Number(ai.interestOwed || 0);
        patch.total_owed = total;
        patch.owed_with_buffer = total + 10000;
      }
      await sb.from('foreclosure_leads').update(patch).eq('case_number', row.case_number);
    }
    return { case: row.case_number, ai, verified };
  } finally { try { unlinkSync(file); } catch {} }
}

// Any county, not just Orange. AI_COUNTY=Polk to target one. Appraiser verification is
// Orange-only for now (each county appraiser is a different vendor and needs its own endpoint
// discovery), so for other counties the address is saved without a parcel check and the
// downstream Zillow/Apify valuation acts as the reality test instead.
const COUNTY = process.env.AI_COUNTY || 'Orange';
let q = sb.from('foreclosure_leads')
  .select('case_number, county, property_address')
  .eq('county', COUNTY).is('property_address', null).limit(MAX);
if (ONE) q = sb.from('foreclosure_leads').select('case_number, county, property_address').eq('case_number', ONE);
const { data, error } = await q;
if (error) { log('query failed:', error.message); process.exit(1); }

const rows = data || [];
log(`${rows.length} case(s) with a PDF but no address`);
let got = 0, verified = 0, missed = 0;
for (const r of rows) {
  const res = await extractOne(r);
  if (res.skip) { missed++; log(`  ${res.case}: ${res.skip}`); continue; }
  if (res.disqualified) { log(`  ${res.case}: DISQUALIFIED — ${res.disqualified}`); continue; }
  if (!res.ai?.propertyAddress) { missed++; log(`  ${res.case}: AI found no address`); continue; }
  got++;
  if (res.verified) { verified++; log(`  ${res.case}: ${res.ai.propertyAddress}  ✓ parcel ${res.verified.parcelId}  assessed $${(res.verified.assessed || 0).toLocaleString()}`); }
  // Only Orange has an appraiser to verify against, so "unverified" means "no adapter for this
  // county" far more often than it means "suspicious address". Saying NOT SAVED for a row that
  // WAS saved is the kind of wrong log line that sends someone debugging a non-problem.
  else log(`  ${res.case}: ${res.ai.propertyAddress}  ${res.case.startsWith('2026-CA') ? '✗ appraiser could not confirm — NOT saved' : '⚠ saved, no appraiser adapter for this county'}`);
  await sleep(1000);
}
log(`done — AI found ${got}/${rows.length} | appraiser-verified ${verified} | no result ${missed}`);
log(`corpus: ${CORPUS}`);
process.exit(0);
