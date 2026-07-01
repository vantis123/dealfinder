// Skip-trace a foreclosure owner → phone numbers, from FREE people-search sites (TruePeopleSearch +
// FastPeopleSearch), searched by the property ADDRESS and matched to the owner name. Camoufox (stealth)
// sails past their Cloudflare. Merges + dedupes numbers across sources, tagging which source(s) had each.
//
// CLI:  node scripts/skiptrace.mjs --address "411 Millwood Pl, Winter Garden, FL 34787" --name "DAIGLE, LARRY" [--headed]
// Or:   import { skipTrace } from './skiptrace.mjs'
import { Camoufox } from 'camoufox-js';

const TPS = 'https://www.truepeoplesearch.com';
const FPS = 'https://www.fastpeoplesearch.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => (String(s).match(/\d/g) || []).join('');
const normPhone = s => { let d = digits(s); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : null; };
const fmtPhone = d => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;

// "DAIGLE, LARRY et al." → "LARRY DAIGLE"; strip a/k/a, et al., trailing junk.
export function parseOwner(defendant) {
  let s = String(defendant || '').replace(/\bet\.?\s*al\.?/ig, '').replace(/\b(a\s?\/?\s?k\s?\/?\s?a|n\s?\/?\s?k\s?\/?\s?a|f\s?\/?\s?k\s?\/?\s?a|aka|fka)\b.*/i, '').replace(/\s+/g, ' ').trim();
  if (s.includes(',')) { const [last, ...rest] = s.split(','); s = `${rest.join(' ').trim()} ${last.trim()}`; }
  return s.replace(/[^A-Za-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function parseAddress(addr) {
  const parts = String(addr || '').split(',').map(x => x.trim());
  return { street: parts[0] || '', csz: parts.slice(1).join(', ') };
}
const lastName = owner => (owner.split(' ').filter(Boolean).pop() || '').toLowerCase();
const nameMatches = (text, ln) => ln && new RegExp('\\b' + ln.replace(/[^a-z]/gi, '') + '\\b', 'i').test(text || '');

// ---- TruePeopleSearch: address search, then NAME+city fallback → person detail(s) → phones ----
async function tpsDetail(p, href) {
  await p.goto(new URL(href, TPS).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3000);
  const d = await p.evaluate(() => {
    const name = (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
    const sel = [...document.querySelectorAll('a[href*="/find/phone"], [itemprop="telephone"]')].map(a => (a.textContent || '').trim());
    const raw = document.body.innerText.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || [];
    return { name, phones: [...sel, ...raw] };
  });
  return { name: d.name, phones: [...new Set(d.phones.map(normPhone).filter(Boolean))] };
}
async function tpsTry(p, url, ln) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4500);
  const hrefs = await p.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/find/person/"]')].map(a => a.getAttribute('href')))].slice(0, 4));
  let best = null;
  for (const href of hrefs) {
    const d = await tpsDetail(p, href);
    if (nameMatches(d.name, ln)) return { ...d, exact: true };  // owner match wins
    if (!best && d.phones.length) best = d;
  }
  return best;
}
async function tps(p, street, csz, owner, ln) {
  try {
    // 1) address search (most precise)
    const r = await tpsTry(p, `${TPS}/resultaddress?streetaddress=${encodeURIComponent(street)}&citystatezip=${encodeURIComponent(csz)}`, ln);
    if (r?.exact) return r;
    // 2) name + city fallback (catches owners whose complaint address doesn't exactly match TPS)
    const city = csz.replace(/\s*\d{5}.*$/, '').trim();
    if (owner && city) {
      const r2 = await tpsTry(p, `${TPS}/results?name=${encodeURIComponent(owner)}&citystatezip=${encodeURIComponent(city)}`, ln);
      if (r2?.exact) return r2;
      return r2 || r;
    }
    return r;
  } catch (e) { return null; }
}

// ---- FastPeopleSearch: address search → person detail(s) → phones ----
async function fps(p, street, csz, ln) {
  try {
    const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const [city, st, zip] = (csz.match(/(.+),?\s*([A-Z]{2})\s*(\d{5})?/) || [, csz, '', '']).slice(1);
    await p.goto(`${FPS}/address/${slug(street)}_${slug(city)}-${(st || '').toLowerCase()}${zip ? '-' + zip : ''}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(4500);
    const hrefs = await p.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/name/"], a[href*="/person/"]')].map(a => a.getAttribute('href')))].filter(h => /\/name\/|\/person\//.test(h)).slice(0, 4));
    let best = null;
    for (const href of hrefs) {
      await p.goto(new URL(href, FPS).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(3500);
      const d = await p.evaluate(() => {
        const name = (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
        const raw = document.body.innerText.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || [];
        return { name, phones: raw };
      });
      const phones = [...new Set(d.phones.map(normPhone).filter(Boolean))];
      const cand = { name: d.name, phones };
      if (nameMatches(d.name, ln)) return cand;
      if (!best && phones.length) best = cand;
    }
    return best;
  } catch (e) { return null; }
}

// Trace using an EXISTING Camoufox page (lets a batch reuse one browser session).
export async function traceWithPage(p, name, address) {
  const owner = parseOwner(name);
  const ln = lastName(owner);
  const { street, csz } = parseAddress(address);
  if (!street || !csz) return { owner, phones: [], matched: null, sources: [], error: 'bad address' };
  const r1 = await tps(p, street, csz, owner, ln);
  const r2 = await fps(p, street, csz, ln);
  // merge phones across sources, tag which source(s) had each (sort: confirmed-by-both first)
  const map = new Map();
  const add = (res, src) => { if (!res) return; for (const d of res.phones) { const e = map.get(d) || { phone: fmtPhone(d), sources: [] }; if (!e.sources.includes(src)) e.sources.push(src); map.set(d, e); } };
  add(r1, 'truepeoplesearch'); add(r2, 'fastpeoplesearch');
  const phones = [...map.values()].sort((a, b) => b.sources.length - a.sources.length);
  return { owner, matched: r1?.name || r2?.name || null, phones, sources: [r1 && 'truepeoplesearch', r2 && 'fastpeoplesearch'].filter(Boolean) };
}

export async function skipTrace({ name, address, headless = true } = {}) {
  const ctx = await Camoufox({ headless, user_data_dir: `/tmp/camou-skip-${process.pid}-${Math.round(performance.now())}` });
  const p = ctx.pages()[0] || await ctx.newPage();
  try { return await traceWithPage(p, name, address); }
  finally { await ctx.close().catch(() => {}); }
}

if (process.argv[1] && process.argv[1].endsWith('skiptrace.mjs')) {
  const arg = k => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : null; };
  skipTrace({ name: arg('name'), address: arg('address'), headless: !process.argv.includes('--headed') })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('skiptrace failed:', e); process.exit(1); });
}
