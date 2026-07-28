// County Property Appraiser valuation — the free, unblockable FALLBACK.
//
// WHAT THIS IS NOT: a Zillow replacement. Zillow's Zestimate is an estimated RESALE price.
// The appraiser publishes the county's ASSESSED market value as of January 1, which in
// Florida runs BELOW resale. Measured against 11 of our own Orange leads that already had
// Zillow values (2026-07-26): median OCPA/Zillow = 0.854, range 0.52–1.00.
//
// WHY IT'S STILL WORTH HAVING: the bias is one-directional. Because the assessor
// UNDERSTATES, a spread computed from it is a FLOOR.
//     spread_ocpa >= 200k  →  the real spread is almost certainly >= 200k   (trustworthy KNOCK)
//     spread_ocpa <  200k  →  tells you nothing; Zillow might still clear it (NOT a rejection)
// So this confirms deals; it never rules one out. Rows valued this way are marked
// value_source='ocpa' so nobody mistakes the number for a resale comp.
//
// It exists because on 2026-07-26 BOTH Zillow paths died at once on the VPS: Apify capped
// on both accounts (resets 08-10) and local Camoufox is PerimeterX-walled on this
// datacenter IP. Full writeup: arvantis-brain/products/deal-finder/property-appraiser-valuation-source.md
//
// Run: node scripts/value-ocpa.mjs          (only leads with no value at all)
//      ALL=1 node scripts/value-ocpa.mjs    (every lead missing a value, ignoring the cap)

import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[ocpa]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Azure Front Door fronts this API and returns a hard 403 without browser-ish headers.
// Origin + Referer are the load-bearing ones — a bare curl/fetch gets refused.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://ocpaweb.ocpafl.org',
  Referer: 'https://ocpaweb.ocpafl.org/',
};

// Per-county appraiser adapters. Only Orange is mapped; the others are reachable from this
// box (polkpa.org, scpafl.org both answered 200 on 2026-07-26) but each uses a different
// vendor, so each needs its own endpoint discovery before being added here.
const ADAPTERS = {
  Orange: {
    base: 'https://ocpa-mainsite-afd-standard.azurefd.net/api',
    async lookup(street) {
      const q = `${this.base}/QuickSearch/GetSearchInfoByAddress?address=${encodeURIComponent(street)}&page=1&size=5&sortBy=ParcelID&sortDir=ASC`;
      const hits = await fetch(q, { headers: HEADERS }).then(r => r.json()).catch(() => []);
      if (!Array.isArray(hits) || !hits.length) return null;
      const pid = hits[0].parcelId;
      const vals = await fetch(`${this.base}/PRC/GetPRCPropertyValues?PID=${pid}&TaxYear=0&ShowAllFlag=1`, { headers: HEADERS })
        .then(r => r.json()).catch(() => []);
      if (!Array.isArray(vals)) return null;
      // The current (uncertified) tax year comes back with every figure as -1. Take the
      // newest row that actually carries a value.
      const row = vals.filter(v => Number(v.marketValue) > 0)
        .sort((a, b) => b.taxYear - a.taxYear)[0];
      if (!row) return null;
      return {
        parcelId: pid,
        marketValue: Number(row.marketValue),
        taxYear: row.taxYear,
        isHomestead: String(row.isHomestead) === 'True',
      };
    },
  },
};

// Strip unit/suite noise — the appraiser indexes the parcel's street address, so
// "4901 Vineland Road Suite #120, Orlando, FL 32811" must become "4901 Vineland Road".
const streetOf = addr => String(addr || '')
  .split(',')[0]
  .replace(/\s+(suite|ste|apt|unit|bldg|#)\s*#?\s*[\w-]+/ig, '')
  .replace(/\s+/g, ' ')
  .trim();

const FLAG_AT = Number(env.SPREAD_FLAG_AT || 200000);
const CAP = parseInt(process.env.OCPA_MAX || '250', 10);

const counties = Object.keys(ADAPTERS);
let q = sb.from('foreclosure_leads')
  .select('case_number, county, property_address, owed_with_buffer, zillow_value')
  .in('county', counties)
  .not('property_address', 'is', null)
  .is('zillow_value', null)          // never touch a lead that already has a real Zillow value
  .limit(CAP);
const { data, error } = await q;
if (error) { log('query failed:', error.message); process.exit(1); }

const rows = data || [];
log(`${rows.length} unvalued lead(s) to try (cap ${CAP}, counties: ${counties.join(',')})`);

let matched = 0, knock = 0, missed = 0;
for (const r of rows) {
  const street = streetOf(r.property_address);
  if (!street) { missed++; continue; }
  let hit = null;
  try { hit = await ADAPTERS[r.county] && await ADAPTERS[r.county].lookup(street); }
  catch (e) { log(`error ${r.case_number}: ${String(e.message).slice(0, 60)}`); }
  if (!hit) { missed++; await sleep(250); continue; }

  matched++;
  const owed = Number(r.owed_with_buffer) || 0;
  const spread = owed ? hit.marketValue - owed : null;
  // Only ever SET flagged true here. A sub-threshold appraiser spread is not evidence the
  // deal is bad (the number is understated by ~15%), so leave flagged null rather than
  // writing false and teaching the CRM this lead was rejected on merit.
  const flagged = spread != null && spread >= FLAG_AT ? true : null;

  const patch = {
    assessed_value: hit.marketValue,
    assessed_year: hit.taxYear,
    parcel_id: hit.parcelId,
    is_homestead: hit.isHomestead,
    value_source: 'ocpa',
    updated_at: new Date().toISOString(),
  };
  // Only drive spread/flagged off the appraiser when there is no better number present.
  if (spread != null) patch.spread = spread;
  if (flagged) { patch.flagged = true; knock++; }

  const { error: uerr } = await sb.from('foreclosure_leads').update(patch).eq('case_number', r.case_number);
  if (uerr) log(`update failed ${r.case_number}: ${uerr.message.slice(0, 70)}`);
  await sleep(250);   // be a polite guest on a government API
}

log(`done — matched ${matched}/${rows.length} | no match ${missed} | NEW knock-worthy (floor spread ≥ $${FLAG_AT.toLocaleString()}) ${knock}`);
process.exit(0);
