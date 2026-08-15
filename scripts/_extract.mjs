// Shared document-extraction ladder for every county scraper.
//
// WHY THIS EXISTS (2026-08-11): each county script had its own private addr()/owed(), and the
// address path only ever called `pdftotext`. The original design note (run-month.mjs:4, initial
// commit) was "Address via pdftotext, owed via FREE OCR (no AI)" — true for Orange, the first
// county built, whose complaints are e-filed with a text layer. It silently became false as Polk /
// Lake / Volusia were added: their documents are SCANNED IMAGES with no text layer, so pdftotext
// returns nothing and the address was lost. `USE_AI=0` (2026-07-14) then removed the Claude
// fallback that had been masking it, and non-Orange address loss went 56% -> 96%.
//
// The fix is the ladder below. OCR is FREE, runs on-box in ~1-2s/page, and the muscle
// (pdftoppm + tesseract) was ALREADY installed and already used for the Value form — it was just
// never pointed at the address document.
//
//   tier 1  pdftotext                      free, instant   — documents with a real text layer
//   tier 2  pdftoppm + tesseract (OCR)     free, on-box    — scanned images / no text layer
//   tier 3  label-aware deterministic pick free            — property addr vs mailing/law-firm addr
//   tier 4  LLM pick on TEXT: local Ollama -> Claude subscription -> metered key (last)
//   tier 5  Claude vision on the PDF (subscription first) — only when 1-4 all fail
//
// Tiers 1-3 are 100% on-box and free and carry ~64% of all results (measured 2026-08-12: 112 of 174).
// Tiers 4-5 leave the box but run on the FLAT subscription, not metered tokens.
//
// Tier 3 is not optional. A 43-page complaint contains the law firm's address, the servicer's
// address AND the borrower's mailing address. Measured on Lake 35-2026-CA-001769-AXXX-01:
//   p.12  "Property Address: 28013 Poppy Ct, Leesburg, FL 34748"      <- correct
//   p.33  "POST OFFICE ADDRESS: 5732 WINDSONG OAK DR, LEESBURG, FL 34748"  <- borrower's MAIL
// Same city, same ZIP, in-county. A first-match regex takes the wrong one and you knock the wrong
// door. Only reading the LABEL disambiguates. This is the same class of bug as 2026-07-02, when an
// Orange case picked up a West Palm Beach law firm and showed a $27M commercial building on Zillow.

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileP = promisify(execFile);
const rnd = () => Math.random().toString(36).slice(2, 9);

// ── REGION guard (not a county guard) ───────────────────────────────────────────────────────────
// Phillip, 2026-08-11: "We don't really need to have a zip guard, it doesn't have to be that
// serious — as long as it's in the same state and in the same general area."
//
// The old per-county ZIP table was too strict and was THROWING AWAY REAL DEALS: Four Corners
// straddles Orange/Osceola/Polk/Lake, so a property one road over from the county line failed its
// own county's list. What the guard actually needs to catch is the FOREIGN law-firm address — the
// Ft. Lauderdale / Boca / Coral Gables / Delray / West Palm / Tampa firms that appear in nearly
// every complaint (the 2026-07-02 bug: a West Palm firm valued as a $27M commercial building).
//
// So: one CENTRAL FLORIDA region list. Wide enough to keep every real deal in the operating area
// plus its neighbours, narrow enough to still reject South Florida and Tampa Bay letterheads.
//   321 Volusia/Daytona · 327 Orlando metro/Seminole/Volusia/Lake · 328 Orlando · 329 Brevard
//   338 Polk (Lakeland/Davenport/Lake Wales) · 344 Marion/Ocala · 345/346 Sumter/Hernando
//   347 Osceola/Kissimmee/Winter Garden/Clermont/Leesburg
export const CENTRAL_FL_ZIPS = ['321', '327', '328', '329', '338', '344', '345', '346', '347'];

export function inRegion(zip) {
  return !!zip && CENTRAL_FL_ZIPS.some(p => String(zip).startsWith(p));
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────
// Phrases that IMMEDIATELY precede the property address in Florida foreclosure filings. Collected
// from real documents 2026-08-11 — the original code only knew a subset, and the non-Orange
// scrapers required a literal "[Property Address]" marker that Volusia/Orange complaints don't have.
export const GOOD_LABELS = [
  /\[\s*property\s+address\s*\]/i,
  /property\s+address\s*[:\-]/i,
  /commonly\s+(known|described)\s+as\s*[:\-]?/i,
  /which\s+currently\s+has\s+the\s+address\s+of/i,
  /with\s+a\s+street\s+address\s+of/i,
  /street\s+address\s*[:\-]/i,
  /also\s+known\s+as\s*[:\-]?/i,
  /\ba\/k\/a\b/i,
  /located\s+at\s*[:\-]?/i,
  /subject\s+property/i,
  /mortgaged\s+(premises|property)/i,
  /real\s+property\s+(located|situated)/i,
];

// Phrases that mark an address as NOT the property. "POST OFFICE ADDRESS" is the borrower's mailing
// address and is frequently in the same city and ZIP as the property — the single most dangerous
// false positive in these documents.
export const BAD_LABELS = [
  /post\s+office\s+address/i,
  /mailing\s+address/i,
  /return\s+to/i,
  /prepared\s+by/i,
  /attorney(s)?\s+for/i,
  /law\s+(group|office|firm)/i,
  /,?\s*(P\.?\s?A\.?|PLLC|LLP|ESQ)\b/i,
  /servicer/i,
  /\blender'?s?\s+address/i,
  /record\s+and\s+return/i,
  /c\/o\b/i,
];

// A law-firm / PO-box shaped address is never a door to knock.
// NOTE: do NOT try to match a floor as `fl\s*\d{1,2}` here — "FL 32809" is a Florida ZIP and an
// earlier draft of this pattern penalised every valid address in the state.
const FIRM_SHAPE = /\b(P\.?\s?O\.?\s+box|post\s+office\s+box|suite\b|ste\.?\s*\d|\d{1,2}(st|nd|rd|th)\s+floor\b|\bfloor\b)/i;

// ── tier 1: text layer ──────────────────────────────────────────────────────────────────────────
export function pdfText(file, { firstPage, lastPage } = {}) {
  try {
    const args = [];
    if (firstPage) args.push('-f', String(firstPage));
    if (lastPage) args.push('-l', String(lastPage));
    args.push(file, '-');
    return execFileSync('pdftotext', args, { maxBuffer: 2e8, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { return ''; }
}

export function pageCount(file) {
  try {
    const info = execFileSync('pdfinfo', [file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return parseInt((info.match(/Pages:\s*(\d+)/) || [])[1] || '0', 10);
  } catch (e) { return 0; }
}

// A text layer can exist but be MOJIBAKE (scrambled ToUnicode CMap — common in Volusia filings).
// Treat "has characters but almost no real words" as no text layer so we fall through to OCR.
export function looksLikeRealText(t) {
  const s = (t || '').replace(/\s+/g, ' ').trim();
  if (s.replace(/\s/g, '').length < 300) return false;
  const words = s.split(' ').filter(w => /^[A-Za-z]{3,}$/.test(w));
  return words.length >= 40;
}

// ── tier 2: OCR ─────────────────────────────────────────────────────────────────────────────────
// Renders ONE page at a time and stops as soon as a good label shows up. Measured 2026-08-11 on
// Lake (43 pages): full document = 82s, but the address label lands on p.12 -> ~23s with early exit.
export async function ocrPage(file, page, dpi = 200) {
  const stem = join(tmpdir(), `df-ocr-${process.pid}-${rnd()}`);
  let png = null;
  try {
    await execFileP('pdftoppm', ['-r', String(dpi), '-png', '-f', String(page), '-l', String(page), '-singlefile', file, stem]);
    png = `${stem}.png`;
    if (!existsSync(png)) return '';
    const { stdout } = await execFileP('tesseract', [png, '-'], { maxBuffer: 5e7 });
    return stdout || '';
  } catch (e) { return ''; }
  finally { if (png) { try { unlinkSync(png); } catch (e) {} } }
}

export async function ocrUntilAnchor(file, { maxPages = 25, dpi = 200, stopOnLabel = true } = {}) {
  const total = pageCount(file) || 1;
  const limit = Math.min(total, maxPages);
  let acc = '';
  for (let p = 1; p <= limit; p++) {
    const t = await ocrPage(file, p, dpi);
    if (!t) continue;
    acc += `\n${t}`;
    // Early exit: a good label AND a parseable in-text address on this page is enough.
    if (stopOnLabel && GOOD_LABELS.some(re => re.test(t)) && addressCandidates(t).length) break;
  }
  return acc;
}

// ── tier 3: candidates + deterministic label-aware scoring ──────────────────────────────────────
// The old regex demanded a strict two-comma `street, city, FL zip`. Real filings write:
//   "6972 Lake Gloria Blvd, Orlando FL 32809"    (no comma before FL)
//   "871 Lemon Rd South Daytona, Fl 32119"       (no comma after street)
//   "301 Illinois Ave Apopka FL 32703"           (no commas at all)
//   "548 RIDGELINE RUN , LONGWOOD , FL 32750"    (pdftotext puts spaces BEFORE commas)
// This one tolerates all four.
const ADDR_RE = new RegExp(
  String.raw`\d{1,6}[A-Za-z]?\s+` +                       // house number
  String.raw`[A-Za-z0-9][A-Za-z0-9 .'#\/-]{2,45}?` +      // street
  String.raw`[\s,]+[A-Za-z][A-Za-z .'-]{1,28}?` +         // city
  String.raw`[\s,]+(?:FL|FLA|FLORIDA)[\s,.]*(\d{5})(?:-\d{4})?`,
  'gi'
);

const norm = s => s.replace(/\s*,\s*/g, ', ').replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();

export function addressCandidates(text) {
  const flat = (text || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' \n ');
  const out = [];
  let m;
  ADDR_RE.lastIndex = 0;
  while ((m = ADDR_RE.exec(flat))) {
    const raw = norm(m[0]);
    if (raw.replace(/\s/g, '').length < 12) continue;
    out.push({ address: raw, zip: m[1], idx: m.index, before: flat.slice(Math.max(0, m.index - 160), m.index) });
  }
  return out;
}

export function scoreCandidate(c, county) {
  let score = 0;
  // REGION (not county) guard — same state, same general area. Rejects the South-FL / Tampa Bay
  // law-firm letterheads without discarding a real deal that sits just over a county line.
  if (inRegion(c.zip)) score += 6;
  else score -= 10;

  for (const re of GOOD_LABELS) if (re.test(c.before)) { score += 8; break; }
  for (const re of BAD_LABELS) if (re.test(c.before)) { score -= 12; break; }
  if (FIRM_SHAPE.test(c.address)) score -= 8;
  // A repeated address across the document is usually the property, not a one-off firm address.
  score += Math.min(c.count || 1, 4);
  return score;
}

export function pickBest(cands, county) {
  if (!cands.length) return null;
  // collapse duplicates (same address seen many times) but keep the BEST label context
  const byKey = new Map();
  for (const c of cands) {
    const k = c.address.toLowerCase().replace(/[^a-z0-9]/g, '');
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...c, count: 1 });
    else {
      prev.count++;
      const better = GOOD_LABELS.some(re => re.test(c.before)) && !GOOD_LABELS.some(re => re.test(prev.before));
      if (better) prev.before = c.before;
    }
  }
  const scored = [...byKey.values()].map(c => ({ ...c, score: scoreCandidate(c, county) }))
    .sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0] : null;
}

// Ambiguous = top two are close, or the winner has no positive label evidence.
export function isAmbiguous(cands, county) {
  const byKey = new Map();
  for (const c of cands) {
    const k = c.address.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!byKey.has(k)) byKey.set(k, { ...c, count: 1 }); else byKey.get(k).count++;
  }
  const scored = [...byKey.values()].map(c => ({ ...c, score: scoreCandidate(c, county) })).sort((a, b) => b.score - a.score);
  if (!scored.length) return true;
  if (scored.length === 1) return scored[0].score <= 0;
  return (scored[0].score - scored[1].score) < 5;
}

// ── tier 4: LLM pick, on TEXT (cheap). Local Ollama first, then Haiku. ──────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

async function ollamaAvailable() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const j = await r.json();
    return (j.models || []).some(m => (m.name || '').startsWith(OLLAMA_MODEL.split(':')[0]));
  } catch (e) { return false; }
}

function buildPickPrompt(cands, snippets) {
  return `From a Florida mortgage foreclosure filing. Choose which candidate is the address of the PROPERTY BEING FORECLOSED.

NOT the law firm, NOT the lender/servicer, and NOT the borrower's "POST OFFICE ADDRESS" or mailing address (those are often in the same city and ZIP as the property — read the label before each one).

Candidates:
${cands.map((c, i) => `${i + 1}. ${c.address}\n   context: …${c.before.slice(-110).replace(/\s+/g, ' ')}…`).join('\n')}

Reply ONLY JSON: {"choice": <number>} or {"choice": null} if none is the foreclosed property.`;
}

async function pickWithOllama(cands) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: buildPickPrompt(cands), stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const n = JSON.parse((j.response || '').match(/\{[\s\S]*?\}/)[0]).choice;
    return Number.isInteger(n) && cands[n - 1] ? cands[n - 1] : null;
  } catch (e) { return null; }
}

// ── Claude on the SUBSCRIPTION, not metered tokens ──────────────────────────────────────────────
// Phillip, 2026-08-11: "make sure that the use ai we are using is the local subscription not tokens."
// Per [[byo-subscription-vs-api-key-auth]] the lever is the AUTH, not the SDK: the Claude Code CLI
// runs against the Max quota (flat), while ANTHROPIC_API_KEY is metered per token. This matters
// twice over here — the metered key currently returns
//   400 "Your credit balance is too low to access the Anthropic API"
// so the API path is not merely expensive, it is DEAD.
//
// Verified 2026-08-11 on this box: `claude -p` returns clean JSON in ~4s, and with `--allowedTools
// Read` it read a Polk complaint that has ZERO text layer and answered correctly in ~8s.
//
// Risk accepted (documented in that note): subscription auth uses an OAuth token that can expire and
// needs interactive re-auth, and it draws on Phillip's personal Max quota. That is acceptable HERE
// because AI is only tier 4-5 — the free tiers (pdftotext/OCR/rules) do the bulk of the work, so a
// subscription hiccup degrades quality instead of stopping the pipeline. Do NOT copy this tier into
// a can't-fail job (e.g. the KMK credit pull) — that one stays on an API key by prior decision.
// AUTH ORDER (Phillip, 2026-08-11): "use the subscription as the main, and then use the API tokens
// as a fallback if it's maxed out, which really happens rarely."
//   'subscription' (default) = try the CLI on the Max quota FIRST, fall back to the metered key only
//                              when the subscription genuinely can't answer (quota hit, OAuth
//                              expired, CLI missing). That is the rare case, so the bill stays ~$0.
//   'api'  = metered key only.   'off' = free tiers only.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const AI_AUTH = (process.env.AI_AUTH || 'subscription').toLowerCase();
const useSub = () => AI_AUTH === 'subscription';
const useApi = () => AI_AUTH === 'subscription' || AI_AUTH === 'api'; // subscription mode may cascade

// Surfaced so a quota/auth failure is visible in the scan log instead of silently degrading —
// the whole point of this incident was that a dead AI path looked identical to a quiet day.
export const aiStats = { subOk: 0, subFail: 0, apiOk: 0, apiFail: 0, lastSubError: null };

async function askClaudeCli(prompt, { file = null, timeoutMs = 120000 } = {}) {
  try {
    const args = ['-p', prompt];
    if (file) args.push('--allowedTools', 'Read');
    const { stdout } = await execFileP(CLAUDE_BIN, args, { timeout: timeoutMs, maxBuffer: 5e7 });
    if (stdout && stdout.trim()) { aiStats.subOk++; return stdout; }
    aiStats.subFail++; return '';
  } catch (e) {
    aiStats.subFail++;
    aiStats.lastSubError = String(e.message || e).slice(0, 160);
    return '';
  }
}

async function pickWithClaude(cands, anthropic) {
  const prompt = buildPickPrompt(cands);
  const parse = (txt) => {
    const m = (txt || '').match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try { const n = JSON.parse(m[0]).choice; return Number.isInteger(n) && cands[n - 1] ? cands[n - 1] : null; }
    catch (e) { return null; }
  };
  // 1) subscription (flat) — the main path
  if (useSub()) { const hit = parse(await askClaudeCli(prompt)); if (hit) return hit; }
  // 2) metered key — the rare fallback when the subscription is maxed/expired
  if (useApi() && anthropic) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      });
      aiStats.apiOk++;
      return parse(msg.content[0].text);
    } catch (e) { aiStats.apiFail++; return null; }
  }
  return null;
}

// ── tier 5: vision on the PDF (last resort) ─────────────────────────────────────────────────────
const VISION_ADDR_Q = 'Florida mortgage foreclosure filing. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed — NOT the lender/servicer/law-firm address and NOT the borrower\'s post-office/mailing address. Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.';

async function addrVision(file, anthropic) {
  // 1) subscription — the CLI reads the PDF directly (works on pure scans, verified 2026-08-11)
  if (useSub()) {
    const out = await askClaudeCli(`Read the file ${file} and answer. ${VISION_ADDR_Q}`, { file });
    const m = out.match(/\{[\s\S]*\}/);
    if (m) { try { const j = JSON.parse(m[0]); if (j.address && /\d/.test(j.address)) return norm(String(j.address)); } catch (e) {} }
  }
  // 2) metered key — rare fallback when the subscription is maxed/expired
  if (!anthropic || !useApi()) return null;
  try {
    const b64 = readFileSync(file).toString('base64');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 150,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: 'Florida mortgage foreclosure filing. Return ONLY the street address of the MORTGAGED PROPERTY being foreclosed — NOT the lender/servicer/law-firm address and NOT the borrower\'s post-office/mailing address. Reply ONLY JSON {"address":"123 Main St, City, FL 12345"} or {"address":null}.' },
      ] }],
    });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return j.address && /\d/.test(j.address) ? norm(String(j.address)) : null;
  } catch (e) { return null; }
}

// ── the public address ladder ───────────────────────────────────────────────────────────────────
// Returns { address, tier, confidence, candidates, text } — NEVER throws. `tier` and the candidate
// list are persisted so a miss is reviewable instead of silently dropped.
// `accepted` is the value a scraper should write to property_address. `address` may still hold a
// low-confidence guess for the review queue — deliberately NOT the same field, so a guess can never
// silently become a door-knock target.
export async function extractAddress(file, { county, useAI = true, anthropic = null, maxOcrPages = 25 } = {}) {
  const result = { address: null, accepted: null, tier: null, confidence: 'none', candidates: [], text: '' };
  // The in-county ZIP guard must apply to the LLM and vision tiers too, not just the regex tiers.
  // Observed 2026-08-11: for Orange 2026-CA-008396-O the LLM confidently returned a KISSIMMEE 34747
  // address (that is Osceola, on the Irlo Bronson tourist strip — very likely a timeshare, which is
  // not a door to knock at all). A model being sure is not evidence it is in the right county, so an
  // out-of-county answer is demoted to `low` and held for review rather than accepted.
  const finish = (r) => {
    // Applies to the LLM/vision tiers too — a model sounding certain is not evidence the property is
    // in the operating area. Out-of-REGION (South FL / Tampa Bay letterhead) is held for review.
    // Demote ONLY when a ZIP is present AND it is outside the region. An address with no ZIP at all
    // ("12414 Baleria Cv Unit 111, Orlando, FL") is not evidence of the wrong county — the label
    // evidence that earned its confidence still stands, and auto-demoting it just loses good leads.
    if (r.address) {
      const z = (String(r.address).match(/\b(\d{5})(?:-\d{4})?\b/g) || []).pop();
      if (z && !inRegion(z.slice(0, 5))) r.confidence = 'low';
    }
    r.accepted = (r.confidence === 'high' || r.confidence === 'medium') ? r.address : null;
    return r;
  };
  if (!file || !existsSync(file)) return finish(result);

  // tier 1 — text layer
  let text = pdfText(file);
  let usedOcr = false;
  if (!looksLikeRealText(text)) {
    // tier 2 — OCR (this is the step that was missing entirely)
    text = await ocrUntilAnchor(file, { maxPages: maxOcrPages });
    usedOcr = true;
  }
  result.text = text;

  let cands = addressCandidates(text);
  // If OCR early-exited without a hit, or the text layer had nothing, sweep more pages.
  if (!cands.length && !usedOcr) {
    text = await ocrUntilAnchor(file, { maxPages: maxOcrPages });
    result.text = text; usedOcr = true;
    cands = addressCandidates(text);
  }
  result.candidates = cands.map(c => c.address);

  if (cands.length) {
    // tier 3 — deterministic label-aware pick
    const best = pickBest(cands, county);
    if (best && !isAmbiguous(cands, county)) {
      result.address = best.address;
      result.tier = usedOcr ? 'ocr+rules' : 'text+rules';
      result.confidence = 'high';
      return finish(result);
    }
    // tier 4 — LLM disambiguation on TEXT (cheap; local first)
    if (useAI) {
      const shortlist = [...new Map(cands.map(c => [c.address.toLowerCase(), c])).values()].slice(0, 8);
      let pick = (await ollamaAvailable()) ? await pickWithOllama(shortlist) : null;
      if (pick) { result.address = pick.address; result.tier = 'llm-local'; result.confidence = 'medium'; return finish(result); }
      pick = await pickWithClaude(shortlist, anthropic);
      // Tier label must say WHERE it ran. This was 'llm-haiku' until 2026-08-12, which read as
      // "metered Haiku API" in the logs when it had actually gone through the flat-rate
      // subscription CLI and billed nothing. A label that misreports cost is a bug.
      if (pick) { result.address = pick.address; result.tier = useSub() ? 'llm-sub' : 'llm-api'; result.confidence = 'medium'; return finish(result); }
    }
    // Nothing disambiguated it. Keep the candidate for the review queue but DO NOT accept it as
    // the address — the original code's rule stands: "never a wrong address". A wrong one means
    // knocking a stranger's door and valuing the wrong house. Observed 2026-08-11: Orange
    // 2026-CA-008396-O scored a Kissimmee 34747 address (that is OSCEOLA) because Orange's ZIP
    // list contains '347' for Winter Garden 34787. High/medium accept, low does not.
    if (best) { result.address = best.address; result.tier = usedOcr ? 'ocr+rules' : 'text+rules'; result.confidence = 'low'; return finish(result); }
  }

  // tier 5 — vision, last resort
  if (useAI) {
    const v = await addrVision(file, anthropic);
    if (v) { result.address = v; result.tier = 'vision'; result.confidence = 'medium'; return finish(result); }
  }
  return finish(result);
}

// ── owed (Value of Real Property form) — same ladder shape ──────────────────────────────────────
// This broke the same way the address did: owedOCR() only ever rendered PAGE 1 (`-singlefile` with
// no page range) and owedAI() was gated behind USE_AI. Among leads that DID have an address,
// missing `owed` went 16% -> 43% after 2026-07-14. No owed = no spread = the lead can never flag.
const money = s => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };

// The Value form is a NUMBERED list ("2. Principal due", "3. Interest owed"), so a naive
// "label then next number" pattern harvests the LIST INDEX. Observed 2026-08-11: three Orange
// forms parsed as principal=2 / interest=3. Every accepted number must therefore be money-shaped
// (commas or cents) and clear a floor — a foreclosure principal is never $2.
const MONEY_SHAPED = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2}`;
export function parseOwed(text) {
  if (!text) return {};
  const t = text.replace(/[ \t]+/g, ' ');
  const grab = (label, floor) => {
    const pats = [
      // FL form layout puts the amount BEFORE the label — this is the reliable one.
      new RegExp(String.raw`(${MONEY_SHAPED})[^\n]{0,20}${label}`, 'i'),
      // label -> amount, but ONLY money-shaped (never a bare list index)
      new RegExp(String.raw`${label}[^\n]{0,40}?\$?\s*(${MONEY_SHAPED})`, 'i'),
    ];
    for (const re of pats) {
      const m = t.match(re);
      const v = m ? money(m[1]) : null;
      if (v != null && v >= floor) return v;
    }
    return null;
  };
  // principal floor 1000 (no real mortgage principal is smaller); interest floor 1.
  return { principalDue: grab('Principal due', 1000), interestOwed: grab('Interest owed', 1) };
}

async function owedVision(file, anthropic) {
  // 1) subscription (flat) — same reasoning as addrVision above.
  if (useSub()) {
    const out = await askClaudeCli(`Read the file ${file} and answer. Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only, no commas.`, { file });
    const m = out.match(/\{[\s\S]*\}/);
    if (m) { try { const j = JSON.parse(m[0]); const r = { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) }; if (r.principalDue != null || r.interestOwed != null) return r; } catch (e) {} }
  }
  // 2) metered key — rare fallback
  if (!anthropic || !useApi()) return {};
  try {
    const b64 = readFileSync(file).toString('base64');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: 'Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only.' },
      ] }],
    });
    const j = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    return { principalDue: money(j.principalDue), interestOwed: money(j.interestOwed) };
  } catch (e) { return {}; }
}

export async function extractOwed(file, { useAI = true, anthropic = null } = {}) {
  if (!file || !existsSync(file)) return {};
  // tier 1 — text layer
  let r = parseOwed(pdfText(file));
  if (r.principalDue != null || r.interestOwed != null) return { ...r, tier: 'text' };
  // tier 2 — OCR every page of the form (it is short; the old code only ever did page 1)
  const pages = Math.min(pageCount(file) || 1, 6);
  let acc = '';
  for (let p = 1; p <= pages; p++) {
    acc += `\n${await ocrPage(file, p)}`;
    r = parseOwed(acc);
    if (r.principalDue != null || r.interestOwed != null) return { ...r, tier: 'ocr' };
  }
  // tier 3 — vision (scrambled-font value forms)
  if (useAI) {
    const v = await owedVision(file, anthropic);
    if (v.principalDue != null || v.interestOwed != null) return { ...v, tier: 'vision' };
  }
  return {};
}

// Filing date — unchanged behaviour, but now falls back to OCR when there is no text layer.
export async function extractFilingDate(file) {
  const pick = (t) => {
    const m = (t || '').match(/E-?Filed:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i) || (t || '').match(/\bFiled:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    return m ? `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : null;
  };
  const t1 = pdfText(file, { firstPage: 1, lastPage: 1 });
  return pick(t1) || pick(await ocrPage(file, 1)) || null;
}
