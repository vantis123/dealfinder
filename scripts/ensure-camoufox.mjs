// Ensure the Camoufox browser is installed before any scrape. We install at RUNTIME (not build) because
// camoufox-js discovers the browser via the GitHub API, which rate-limits the shared Railway BUILD IP
// (60/hr → 403 → CamoufoxNotInstalled). At runtime the GITHUB_TOKEN service var is present → authenticated
// (5000/hr) → reliable. With a Railway volume at /opt/camoufox this runs once and persists across restarts.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function ensureCamoufox() {
  let pk;
  try { pk = await import('camoufox-js/dist/pkgman.js'); }
  catch { pk = await import(join(ROOT, 'node_modules/camoufox-js/dist/pkgman.js')); }
  try {
    pk.launchPath();              // throws CamoufoxNotInstalled if the browser isn't there
    return 'present';
  } catch {
    console.log('[camoufox] not installed — fetching (runtime, authenticated)…');
    execFileSync(process.execPath, [join(ROOT, 'node_modules/camoufox-js/dist/__main__.js'), 'fetch'],
      { stdio: 'inherit', env: process.env });
    pk.launchPath();              // verify — throw loudly if the fetch still didn't produce a binary
    console.log('[camoufox] installed ✓');
    return 'installed';
  }
}

// Allow running directly: `node scripts/ensure-camoufox.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureCamoufox().then(s => { console.log('camoufox:', s); process.exit(0); })
    .catch(e => { console.error('camoufox ensure FAILED:', e.message); process.exit(1); });
}
