// Screenshot the live dashboard at iPhone width to verify mobile layout.
import { Camoufox } from 'camoufox-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';
// Canonical VPS URL (2026-08-05), overridable via DEAL_FINDER_URL. The old hardcoded Railway host
// was DEAD (404) with no env override — this had been screenshotting a 404 page since Railway died.
const BASE = loadEnv(join(dirname(fileURLToPath(import.meta.url)), '..')).DEAL_FINDER_URL
  || 'https://dealfinder.srv1856446.hstgr.cloud';
const OUT = '/tmp/df-recon';
const ctx = await Camoufox({ headless: true, user_data_dir: '/tmp/df-recon/mobile-cf',
  window: { width: 390, height: 844 } });
const page = ctx.pages()[0] || await ctx.newPage();
await page.setViewportSize({ width: 390, height: 844 });
for (const [path, name] of [['/foreclosures', 'fc'], ['/join', 'join']]) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/mobile-${name}.png` }).catch(()=>{});
  console.log('shot', name);
}
// also open the drawer to confirm the hamburger works
await page.goto(BASE + '/foreclosures', { waitUntil: 'domcontentloaded' }).catch(()=>{});
await page.waitForTimeout(2500);
await page.evaluate(() => { const b = document.querySelector('button[aria-label="Open menu"]'); if (b) b.click(); });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/mobile-drawer.png` }).catch(()=>{});
console.log('shot drawer');
await ctx.close();
