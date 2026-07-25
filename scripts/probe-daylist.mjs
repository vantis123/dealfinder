// Diagnostic: log in to <county>.realforeclose.com, open the first future auction day's
// DAYLIST page, and dump body text + HTML + screenshot so we can see what the site serves now.
// Run: COUNTY=orange node scripts/probe-daylist.mjs [MM/DD/YYYY]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadEnv } from './_env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const env = loadEnv(ROOT);
const COUNTY = (process.env.COUNTY || 'orange').toLowerCase();
const base = `https://${COUNTY}.realforeclose.com`;
const OUT = process.env.PROBE_OUT || '/tmp/df-probe';
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clearOKs(page, n = 6) {
  for (let i = 0; i < n; i++) {
    await sleep(1000);
    const clicked = await page.evaluate(() => {
      const e = [...document.querySelectorAll('button,a,input,div[onclick],span[onclick]')]
        .find(x => /^(ok|continue|i agree|accept|proceed|enter|confirm)$/i.test((x.innerText || x.value || '').trim()));
      if (e) { e.click(); return true; } return false;
    }).catch(() => false);
    if (!clicked) break;
  }
}

const { Camoufox } = await import('camoufox-js');
const ctx = await Camoufox({ headless: process.env.HEADLESS !== '0', user_data_dir: join(ROOT, '.rf-session', `${COUNTY}-probe-cf`) });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('dialog', async d => { await d.accept().catch(() => {}); });

try {
  await page.goto(`${base}/index.cfm?ZACTION=USER&ZMETHOD=CALENDAR`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  if (await page.$('#LogName')) {
    log('logging in…');
    await page.fill('#LogName', env.REALFORECLOSE_USER);
    await page.fill('#LogPass', env.REALFORECLOSE_PASS);
    await page.click('#LogButton').catch(() => {});
    await sleep(3500);
    await clearOKs(page);
    await page.goto(`${base}/index.cfm?ZACTION=USER&ZMETHOD=CALENDAR`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await clearOKs(page, 3);
  } else { log('session reused'); await clearOKs(page, 2); }

  await page.screenshot({ path: join(OUT, 'calendar.png'), fullPage: true }).catch(e => log('calendar shot failed:', e.message.slice(0, 60)));
  const calText = await page.evaluate(() => document.body.innerText).catch(() => '');
  writeFileSync(join(OUT, 'calendar.txt'), `URL: ${page.url()}\n\n${calText}`);
  log('calendar URL:', page.url(), '| text length:', calText.length, '| CALBOX days:', (await page.$$('.CALBOX[dayid]')).length);

  // first future FC auction day (or CLI arg)
  let date = process.argv[2];
  if (!date) {
    const days = await page.$$eval('.CALBOX[dayid]', els => els.map(e => ({ d: e.getAttribute('dayid'), t: e.innerText || '' }))).catch(() => []);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const { d, t } of days) {
      if (!/FC|foreclosure/i.test(t)) continue;
      const [m, dd, y] = d.split('/').map(Number);
      if (new Date(y, m - 1, dd) >= today) { date = d; break; }
    }
  }
  log('probing DAYLIST for', date);
  await page.goto(`${base}/index.cfm?zaction=AUCTION&Zmethod=DAYLIST&AUCTIONDATE=${date}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await clearOKs(page, 2);
  await sleep(3000);

  const url = page.url();
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const html = await page.content().catch(() => '');
  const frames = page.frames().map(f => f.url());
  const linkSample = await page.$$eval('a', as => as.slice(0, 60).map(a => `${(a.innerText || '').trim().slice(0, 40)} => ${a.getAttribute('href')}`)).catch(() => []);
  writeFileSync(join(OUT, 'daylist.txt'), `URL: ${url}\nFRAMES:\n${frames.join('\n')}\n\nBODY TEXT:\n${text}`);
  writeFileSync(join(OUT, 'daylist.html'), html);
  writeFileSync(join(OUT, 'daylist-links.txt'), linkSample.join('\n'));
  await page.screenshot({ path: join(OUT, 'daylist.png'), fullPage: true }).catch(e => log('daylist shot failed:', e.message.slice(0, 60)));
  log('final URL:', url);
  log('body text length:', text.length, '| html length:', html.length);
  log('has "Case #":', /case #/i.test(text), '| has "Final Judgment":', /final judgment/i.test(text), '| has "no auctions":', /no auctions/i.test(text));
  log('detail links found:', (html.match(/zmethod=details/gi) || []).length);
  log('wrote', OUT);
} catch (e) {
  log('PROBE ERROR', e.message);
} finally {
  await ctx.close();
}
process.exit(0);
