// LOCAL EXTRACTOR — pulls the property address out of a foreclosure PDF using only tools that
// live on this box: pdftotext, pdftoppm + tesseract. No Claude, no API, no subscription.
//
// WHY
// Phillip 2026-07-26: "we shouldn't need a claude cli, we should just be using the VPS to do it."
// That was always the plan — "use AI extraction to build the correct code... then make a code
// that doesn't need to use any of our subscription on Claude." The AI was the teacher. This is
// the product.
//
// WHAT THE TEACHER TAUGHT US (from data/extraction-corpus.jsonl)
// 1. The address sits 0-6 lines BELOW its label, not beside it. The old parser looked ~70 chars
//    BEHIND a candidate, which is why it missed nearly everything:
//        Street Address:
//                            <- blank line
//        2753 BASS LAKE BLVD
//        ORLANDO, FL 32806
// 2. Plenty of complaints use no label at all — "real property located at 182 Kentucky Blue
//    Circle, Apopka, Florida 32712, legally described as Lot 9..."
// 3. The dangerous wrong answers are specific and recognisable: the plaintiff bank's office
//    (Polk page-1 complaints all show "1317 George Jenkins Blvd, Lakeland"), the law firm's
//    service address, and out-of-state defendant mailing addresses (Chicago IL, Carmel IN).
// 4. Scanned PDFs have no text layer at all — those need OCR before any of this can run.
//
// HONESTY
// This does NOT beat the model on ambiguous documents. It is meant to handle the common shapes
// for free and hand the rest to the AI pass. Run scripts/bench-extract.mjs to see exactly how
// much of the corpus it currently recovers — never assume, measure.

import { execFile } from 'node:child_process';
import { existsSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sh = (cmd, args, timeout = 120000) => new Promise(r =>
  execFile(cmd, args, { timeout, maxBuffer: 9e7 }, (e, so) => r(e ? '' : String(so || ''))));

// ── text acquisition ───────────────────────────────────────────────────────────
export async function pdfToText(file, { ocrPages = 25 } = {}) {
  let txt = await sh('pdftotext', ['-layout', file, '-']);
  // A real text layer is thousands of characters. Anything under this is a scan.
  if (txt.replace(/\s/g, '').length > 400) return { text: txt, ocr: false };

  // OCR page-by-page with EARLY EXIT, instead of a flat first-3-pages sweep.
  // Measured 2026-08-15 on Lake 35-2026-CA-001769-AXXX-01 (43 pages, zero text layer): the
  // property address is on PAGE 12 — "Property Address: 28013 Poppy Ct, Leesburg, FL 34748".
  // A 3-page cap could never have found it, which is why that whole class of document came back
  // empty. Full-document OCR is 82s; stopping at the first usable hit is ~23s.
  const total = await pageCount(file);
  const limit = Math.min(total || ocrPages, ocrPages);
  let out = '';
  for (let pg = 1; pg <= limit; pg++) {
    const stem = join(tmpdir(), `xl-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
    await sh('pdftoppm', ['-r', '200', '-png', '-f', String(pg), '-l', String(pg), '-singlefile', file, stem], 120000);
    const png = `${stem}.png`;
    if (!existsSync(png)) continue;
    out += await sh('tesseract', [png, '-'], 120000) + '\n';
    try { unlinkSync(png); } catch {}
    // Stop as soon as the accumulated text yields a plausible address.
    if (addressFromText(out).address) break;
  }
  return { text: out, ocr: true };
}

async function pageCount(file) {
  const info = await sh('pdfinfo', [file]);
  const m = info.match(/Pages:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// ── the rules ──────────────────────────────────────────────────────────────────
// Suffix list, trimmed by evidence. RUN / POINT / BEND / COVE / PATH / LOOP / SQUARE were
// removed: they are ordinary English and surveyor vocabulary, and they were what produced
// "THENCE RUN S 55°05'58\" W" and prose fragments like "6 was in excess of the just".
const HARD_SUFFIX = String.raw`STREET|ST|AVENUE|AVE|DRIVE|DR|ROAD|RD|LANE|LN|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|WAY|TERRACE|TER|PLACE|PL|PARKWAY|PKWY|TRAIL|TRL|CROSSING|XING|HIGHWAY|HWY`;
const STREET = String.raw`\d{1,6}[A-Z]?\s+[NSEW]{0,2}\.?\s*[A-Za-z0-9'.\- ]{2,40}?\s+(?:` + HARD_SUFFIX + String.raw`)\b`;   // \s+ not \s*: see SUTTER/TER bug

// SOFT suffixes — RUN / POINT / BEND / COVE / PATH / LOOP / SQUARE / RIDGE / WALK were removed
// from the list above because they are ordinary English and surveyor vocabulary, and they
// produced `THENCE RUN S 55°05'58" W` and prose fragments. But they are also real Florida street
// types, and dropping them silently cost real deals — measured 2026-08-15 against live documents:
//   548 RIDGELINE RUN, LONGWOOD, FL 32750      16152 VOLTERRA POINT MONTVERDE, FL 34756
//   801 SUTTER LOOP, LONGWOOD, FL 32750        1403 Dalkeith Cove, Sanford, FL 32771
// They are readmitted ONLY when the very next thing is a city + FL + ZIP. Prose never does that,
// so the disambiguation is the trailing geography rather than the word itself.
const SOFT_SUFFIX = String.raw`RUN|POINT|PT|BEND|COVE|CV|PATH|LOOP|SQUARE|SQ|RIDGE|WALK|GLEN|CHASE|LANDING|POINTE`;
// The city usually sits on the NEXT line, so a same-line lookahead can't see it. Instead the
// soft match is provisional: assemble() only accepts it if the finished address ends in a
// Florida city + ZIP. Prose ("THENCE RUN S 55°05'58\" W") never gets that far.
const STREET_SOFT = String.raw`\d{1,6}[A-Z]?\s+[NSEW]{0,2}\.?\s*[A-Za-z0-9'.\- ]{2,40}?\s+(?:` + SOFT_SUFFIX + String.raw`)\b`;

// Addresses that are never the subject property. Learned from real misfires:
// the plaintiff's HQ, the law firm's service address, out-of-state mailing addresses.
const NEVER = [
  // The borrower's MAILING address. Measured on Lake 35-2026-CA-001769-AXXX-01: the property is
  // "28013 Poppy Ct" (p.12) but p.33 carries "POST OFFICE ADDRESS: 5732 WINDSONG OAK DR" — same
  // city, same ZIP, in-county, and it passes every other guard. This is the single most dangerous
  // false positive in these documents because nothing else about it looks wrong.
  /post\s*office\s*address/i,
  /mailing\s+address/i,
  /george jenkins/i,           // Polk plaintiff HQ, on every page-1 complaint
  /celebration boulevard/i,     // timeshare resort address shared across defendants
  /corporate\s+(dr|drive|blvd)/i,
  // EVERY law-firm/plaintiff address observed across all five counties carried a suite number:
  //   6409 Congress Ave., Suite 100   (Orange + Lake, same firm)
  //   1201 S. Orlando Avenue, Suite 430 · 750 Park of Commerce Blvd., Suite 130   (Polk)
  //   1065 Maitland Center Commons Blvd.   (Seminole)
  // A foreclosed single-family home is never described with a suite number.
  /\b(suite|ste)\.?\s*#?\s*[\w-]+/i,
  /maitland center|park of commerce|congress ave/i,
  // Fee schedules and payment prose. The "Value of Real Property" affidavit is full of
  // "$905 Value greater than $50,000 but less than $250,000 with 5 defendants or less".
  /\$/,
  /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/i, // not Florida
];
// A street address is a noun phrase. Prose is not. These fragments got through the label scan
// because the suffix list matched mid-sentence — "6 was in excess of the just", "2026 and all
// subsequent payments have". No real address contains a verb or a conjunction.
const PROSE_WORDS = /\b(was|were|is|are|and|the|that|this|with|from|have|has|been|shall|will|which|excess|subsequent|payment|payments|amount|interest|note|owed|due|less|greater|than|defendants?)\b/i;
const isPlausible = a =>
  a && a.length > 8 && /\d/.test(a)
  && !NEVER.some(re => re.test(a))
  && !PROSE_WORDS.test(a.replace(/,.*$/, ''));   // test the STREET part only — city names are safe

// Pull "<street>, <city>, FL <zip>" out of a block of lines starting at index i.
function assemble(lines, i, { anchored = false } = {}) {
  const first = (lines[i] || '').trim();
  // hard suffix first; then the soft list, which only matches when a city+FL+ZIP follows it
  let m = first.match(new RegExp(STREET, 'i'));
  let soft = false;
  if (!m) { m = first.match(new RegExp(STREET_SOFT, 'i')); soft = !!m; }
  if (!m) return null;
  // Benchmark 2026-07-26 produced "6 was in excess of the just" and "2026 and all subsequent
  // payments have" — the street pattern firing mid-sentence on prose. For an unlabelled guess,
  // demand the address START the line. Labelled hits keep the looser rule; the label is the
  // evidence there.
  if (anchored && first.toUpperCase().indexOf(m[0].toUpperCase()) > 2) return null;

  let addr = m[0].replace(/\s{2,}/g, ' ').trim();
  const rest = first.slice(first.toUpperCase().indexOf(m[0].toUpperCase()) + m[0].length);

  // Keep the unit. Benchmark showed 4 "wrong" answers that were really right but dropped
  // "#100", "Unit #20302", "Unit 21" — and for a condo that is the difference between the
  // right door and a stranger's.
  const unit = [rest, lines[i + 1] || ''].join(' ')
    .match(/\b(?:unit|apt|apartment|#|ste|suite)\s*#?\s*([A-Za-z0-9-]{1,8})\b/i);
  if (unit) addr += `, Unit ${unit[1]}`;

  const tail = [rest, lines[i + 1] || '', lines[i + 2] || ''].join(' ');
  const csz = tail.match(/([A-Za-z .'-]{3,30}),?\s*(?:FL|FLORIDA)[, ]*\s*(\d{5}(?:-\d{4})?)?/i);
  if (csz) addr += `, ${csz[1].trim().replace(/\s{2,}/g, ' ')}, FL${csz[2] ? ' ' + csz[2] : ''}`;
  // A soft-suffix word is only an address if the geography actually followed it.
  else if (soft) return null;
  return addr.replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
}

const LABEL = /(street address|property address|commonly known as|also known as|a\/k\/a|subject property)/i;

// Central Florida ZIP prefixes — the operating area plus neighbours.
//   321 Volusia · 327 Orlando metro/Seminole/Volusia/Lake · 328 Orlando · 329 Brevard
//   338 Polk · 344 Marion · 345/346 Sumter/Hernando · 347 Osceola/Kissimmee/Winter Garden/Clermont
// This is what makes the bare-guess rule below safe to re-enable: the dangerous answers it used to
// produce were Sunrise / Fort Lauderdale / Boca law-firm addresses, and every one of them fails here.
const REGION = ['321','327','328','329','338','344','345','346','347'];
const inRegion = a => { const m = String(a).match(/\b(\d{5})(?:-\d{4})?\b/g); const z = m && m[m.length-1]; return !!z && REGION.some(p => z.startsWith(p)); };

// Every prose form observed in the 2026-07-29 format sweep, verbatim from real filings:
//   Polk     "See Mortgage. Exhibit B hereto. The Property is located at 1336 Madison Circle, Haines City."
//   Osceola  "which currently has the address of 3521 Anibal St, Kissimmee, FL 34746"
//   Osceola  "located at: 3521 Anibal St, Kissimmee, FL 34746 [Property Address]"
//   Orange   "real property located at 182 Kentucky Blue Circle, Apopka, Florida 32712"
//   Seminole "638 King Harold Ct. Oviedo, FL 32765 (the \u201cProperty\u201d)"
const PROSE = /(?:which )?currently has the address of\s+|(?:real property |property )?(?:is\s+)?(?:located|situated) at:?\s+/i;

// Seminole names the property then labels it in a trailing parenthetical instead of using a
// leading label — the address comes BEFORE the marker, so it needs its own pass.
const TRAILING_PROPERTY = /([^\n]{10,80}?)\s*\((?:the\s*)?[\u201c"']?Property[\u201d"']?\)/i;

/** Extract a property address from PDF text. Returns {address, how} or {address:null}. */
export function addressFromText(text) {
  const lines = String(text).split('\n');

  // Rule 1 — labelled, value 0-6 lines below (THE big one the old parser missed)
  for (let i = 0; i < lines.length; i++) {
    if (!LABEL.test(lines[i])) continue;
    // ...unless the label line itself marks a mailing/PO address (see NEVER above) — scanning
    // forward from it walks straight onto the borrower's mail, not the property.
    if (/post\s*office|mailing/i.test(lines[i])) continue;
    for (let j = 0; j <= 6 && i + j < lines.length; j++) {
      const a = assemble(lines, i + j);
      if (isPlausible(a)) return { address: a, how: `label+${j}` };
    }
  }

  // Rule 2 — prose, no label: "located at 182 Kentucky Blue Circle, Apopka, Florida 32712"
  const flat = lines.join('\n');
  let m;
  // PROSE contains a top-level alternation, so it MUST be wrapped — otherwise
  // `A|B(capture)` parses as "A" or "B(capture)" and m[1] is undefined whenever the first
  // branch matches. That threw TypeError on the first real run.
  const re = new RegExp('(?:' + PROSE.source + ')(' + STREET + '[^\\n]{0,60})', 'ig');
  while ((m = re.exec(flat))) {
    const seg = m[1].split(/,\s*legally|,\s*according/i)[0];
    const a = seg.replace(/\s{2,}/g, ' ').replace(/[.;]$/, '').trim();
    if (isPlausible(a)) return { address: a, how: 'prose' };
  }

  // Rule 2b — Seminole shape: "638 King Harold Ct. Oviedo, FL 32765 (the \u201cProperty\u201d)".
  // The label trails the value, so scanning forward from a label never finds it.
  for (const line of lines) {
    const tp = line.match(TRAILING_PROPERTY);
    if (!tp) continue;
    const m = tp[1].match(new RegExp(STREET, 'i'));
    if (!m) continue;
    const a = tp[1].replace(/\s{2,}/g, ' ').trim();
    if (isPlausible(a)) return { address: a, how: 'trailing-property' };
  }

  // Rule 3 — last resort: a street-shaped line that STARTS the line, survives the NEVER list,
  // and names Florida. Deliberately strict; a wrong address is worse than none, because it
  // sends a person to a stranger's door.
  // DISABLED after measurement. On 18 real PDFs this rule produced 4 correct answers and 3
  // dangerous ones — law-firm addresses in Sunrise and Fort Lauderdale (Broward filing hubs,
  // never the Orange property) and prose fragments like "6 was in excess of the just".
  // For a door-knock list, precision beats recall: a wrong address sends a person to a
  // stranger's house, while a missing one just falls through to the AI pass. Re-enable with
  // BARE_GUESS=1 only if a county is verified to need it.
  // RE-ENABLED 2026-08-15, now gated on the Central FL region.
  // It was disabled because on 18 real PDFs it produced 4 correct answers and 3 dangerous ones —
  // law-firm addresses in Sunrise and Fort Lauderdale (Broward filing hubs, never the property).
  // Those are exactly what inRegion() rejects, so the reason for disabling it is now handled.
  // The cost of leaving it off was measured: ORANGE sits at 47% addressed with 247 leads missing,
  // and its documents routinely carry a clean unlabelled address on its own line —
  //   "2914 RODRICK CIR, ORLANDO, FLORIDA 32824"   (twice in 2026-CA-008612-O, no label anywhere)
  // Still deliberately strict: must START the line, survive NEVER + PROSE_WORDS, name Florida,
  // AND carry an in-region ZIP. Set BARE_GUESS=0 to turn it back off.
  if (process.env.BARE_GUESS !== '0') {
    for (let i = 0; i < lines.length; i++) {
      const a = assemble(lines, i, { anchored: true });
      if (isPlausible(a) && /\bFL\b|FLORIDA/i.test(a) && inRegion(a)) return { address: a, how: 'bare-region' };
    }
  }
  return { address: null, how: null };
}

export async function addressFromPdf(file) {
  if (!existsSync(file)) return { address: null, how: null, ocr: false };
  const { text, ocr } = await pdfToText(file);
  return { ...addressFromText(text), ocr };
}

// CLI:  node scripts/extract-local.mjs <file.pdf>
if (process.argv[1] && process.argv[1].endsWith('extract-local.mjs') && process.argv[2]) {
  const r = await addressFromPdf(process.argv[2]);
  console.log(JSON.stringify(r));
}
