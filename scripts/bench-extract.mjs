// BENCHMARK — how much of the AI's work can the local extractor do for free?
//
// The AI corpus is the answer key: every record holds a real PDF's text snippet and the address
// Claude found, most of them confirmed against the county appraiser. Scoring the local rules
// against it turns "is the free version good enough?" from an opinion into a number.
//
// Run: node scripts/bench-extract.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addressFromText } from './extract-local.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'data', 'extraction-corpus.jsonl');
if (!existsSync(CORPUS)) { console.log('no corpus yet — run scripts/extract-ai.mjs first'); process.exit(0); }

// Compare on the street number + street name only. "2753 Bass Lake Blvd, Orlando, FL 32806" and
// "2753 BASS LAKE BLVD ORLANDO FL" are the same answer; punctuation and case are not the test.
const key = a => String(a || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
  .replace(/\b(FL|FLORIDA|\d{5})\b/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');

const recs = readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
// One record per case (later runs supersede earlier ones), and only those the AI actually solved.
const byCase = new Map(recs.map(r => [r.case, r]));
const answered = [...byCase.values()].filter(r => (r.ai || {}).propertyAddress && r.snippet);

let hit = 0, miss = 0, wrong = 0;
const how = {};
const failures = [];
for (const r of answered) {
  const truth = r.ai.propertyAddress;
  const got = addressFromText(r.snippet);
  if (!got.address) { miss++; failures.push([r.case, 'no match', truth]); continue; }
  how[got.how] = (how[got.how] || 0) + 1;
  if (key(got.address) === key(truth)) hit++;
  else { wrong++; failures.push([r.case, `WRONG: ${got.address}`, truth]); }
}

const total = answered.length;
console.log(`\nAnswer key: ${total} cases the AI solved (corpus has ${byCase.size} total)\n`);
console.log(`  ✅ local matches AI : ${hit}  (${total ? Math.round(100 * hit / total) : 0}%)`);
console.log(`  ⚠️  local disagrees  : ${wrong}`);
console.log(`  ➖ local found none : ${miss}`);
console.log(`\n  rule usage: ${JSON.stringify(how)}`);
console.log('\n  NOTE: the corpus stores only a SNIPPET around address labels, so this is a floor —');
console.log('  the extractor sees more context when run against the real PDF.\n');
if (failures.length) {
  console.log('  first failures (case | local | AI truth):');
  failures.slice(0, 12).forEach(([c, g, t]) => console.log(`    ${c}\n      local: ${g}\n      truth: ${t}`));
}
