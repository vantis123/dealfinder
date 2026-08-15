// FORMAT ANALYSIS — read every failing document, work out what it IS, where the address
// actually sits, and why the parser walked past it.
//
// Phillip 2026-07-29: "read and understand the format of every document we are having issues
// [with] and analyze why we are missing it and where exactly does it show the address."
//
// Guessing at regexes has cost us a full cycle already (a "fix" moved the local extractor
// 67% -> 61%). This builds the evidence first: for each failing case it dumps the document's
// real shape, every address-like string in it, and the exact line offset between the label and
// the value. Output is JSON so the rules can be written FROM it instead of at it.
//
// Run:  node scripts/analyze-formats.mjs                 # 6 per county
//       PER_COUNTY=12 node scripts/analyze-formats.mjs
//       ONLY=Polk node scripts/analyze-formats.mjs

import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync, readdirSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PER = parseInt(process.env.PER_COUNTY || '6', 10);
const ONLY = process.env.ONLY || '';
const log = (...a) => console.log(...a);

const sh = (cmd, args, t = 120000) => new Promise(r =>
  execFile(cmd, args, { timeout: t, maxBuffer: 9e7 }, (e, so) => r(e ? '' : String(so || ''))));

// Any street-shaped string, deliberately loose — this is analysis, not extraction. We WANT the
// false positives here so we can see what the parser is competing against.
const STREET = /\b\d{1,6}[A-Z]?\s+[NSEW]{0,2}\.?\s*[A-Za-z0-9'.\- ]{2,40}?\s*(?:STREET|ST|AVENUE|AVE|DRIVE|DR|ROAD|RD|LANE|LN|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|WAY|TERRACE|TER|PLACE|PL|PARKWAY|PKWY|TRAIL|TRL|LOOP|RUN|POINT|PT|COVE|CV|BEND|CROSSING|XING|SQUARE|SQ|HIGHWAY|HWY)\b/i;
const LABEL = /(street address|property address|commonly known as|also known as|a\/k\/a|subject property|located at|situated at|property is located)/i;
const LEGAL = /(lot\s+\d+|block\s+[A-Z0-9]+|plat book|according to the (map or )?plat|condominium|unit\s+\d+.*declaration)/i;

async function textOf(file) {
  const t = await sh('pdftotext', ['-layout', file, '-']);
  if (t.replace(/\s/g, '').length > 400) return { text: t, ocr: false };
  // Scanned — render and OCR the first pages.
  const stem = join(tmpdir(), `af-${process.pid}-${Math.random().toString(36).slice(2, 6)}`);
  await sh('pdftoppm', ['-r', '200', '-png', '-f', '1', '-l', '3', file, stem], 240000);
  let out = '';
  const base = stem.split('/').pop();
  for (const f of readdirSync(tmpdir()).filter(n => n.startsWith(base)).sort()) {
    const p = join(tmpdir(), f);
    out += await sh('tesseract', [p, '-'], 120000) + '\n';
    try { unlinkSync(p); } catch {}
  }
  return { text: out, ocr: true };
}

function analyze(text) {
  const lines = text.split('\n');
  const labels = [], addrs = [];
  lines.forEach((l, i) => {
    if (LABEL.test(l)) labels.push({ line: i, text: l.trim().slice(0, 90) });
    const m = l.match(STREET);
    if (m) addrs.push({ line: i, hit: m[0].trim().slice(0, 60), full: l.trim().slice(0, 110) });
  });
  // For every label, how far below it does the nearest address-shaped line sit? This offset is
  // the single most important number — the old parser looked BEHIND the candidate, so any
  // positive offset was invisible to it.
  const offsets = labels.map(L => {
    const next = addrs.find(a => a.line >= L.line && a.line - L.line <= 10);
    return { label: L.text.slice(0, 50), offset: next ? next.line - L.line : null, value: next?.hit || null };
  });
  const docType =
    /notice of lis pendens/i.test(text) ? 'lis pendens'
    : /summons/i.test(text) ? 'summons'
    : /final judgment/i.test(text) ? 'final judgment'
    : /verified complaint|complaint for/i.test(text) ? 'complaint'
    : /value of real property|worksheet/i.test(text) ? 'value of property'
    : 'other';
  return {
    docType,
    lines: lines.length,
    labelCount: labels.length,
    addrCount: addrs.length,
    hasLegalDescription: LEGAL.test(text),
    offsets: offsets.slice(0, 5),
    addresses: addrs.slice(0, 6),
  };
}

const counties = ONLY ? [ONLY] : ['Polk', 'Orange', 'Seminole', 'Osceola', 'Lake'];
const results = [];

for (const county of counties) {
  const { data } = await sb.from('foreclosure_leads')
    .select('case_number, county')
    .eq('county', county).is('property_address', null)
    .or('complaint_url.not.is.null,value_url.not.is.null')
    .limit(PER);
  log(`\n${'='.repeat(78)}\n${county} — ${(data || []).length} failing case(s)\n${'='.repeat(78)}`);

  for (const row of data || []) {
    const safe = row.case_number.replace(/[^A-Za-z0-9._-]/g, '_');
    for (const kind of ['lispendens', 'complaint', 'value']) {
      const { data: blob } = await sb.storage.from('foreclosure-docs').download(`${safe}/${kind}.pdf`);
      if (!blob) continue;
      const f = join(tmpdir(), `af-${safe}-${kind}.pdf`);
      writeFileSync(f, Buffer.from(await blob.arrayBuffer()));
      const { text, ocr } = await textOf(f);
      const a = analyze(text);
      try { unlinkSync(f); } catch {}

      results.push({ county, case: row.case_number, kind, ocr, ...a });
      log(`\n  ${row.case_number}  [${kind}]  ${ocr ? 'SCANNED→OCR' : 'text layer'}  type=${a.docType}  lines=${a.lines}`);
      log(`    labels=${a.labelCount}  address-shaped lines=${a.addrCount}  legal-description=${a.hasLegalDescription}`);
      if (a.offsets.length) {
        log(`    label → value offsets:`);
        a.offsets.forEach(o => log(`      "${o.label}"  →  ${o.offset === null ? 'NO address within 10 lines' : `+${o.offset} lines : ${o.value}`}`));
      }
      if (a.addresses.length) {
        log(`    address-shaped strings found:`);
        a.addresses.forEach(x => log(`      L${String(x.line).padStart(4)}  ${x.full}`));
      } else log(`    ⚠️  NO address-shaped string anywhere in this document`);
    }
  }
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
// Append across runs — an earlier version overwrote this per county, destroying the evidence
// from every prior run. The corpus is the point; never truncate it.
const prior = existsSync(join(ROOT,'data','format-analysis.json')) ? JSON.parse(readFileSync(join(ROOT,'data','format-analysis.json'),'utf8')) : [];
writeFileSync(join(ROOT, 'data', 'format-analysis.json'), JSON.stringify([...prior, ...results], null, 2));
log(`\n\n${'='.repeat(78)}\nwrote data/format-analysis.json (${results.length} documents)`);
