// Shared env loader — works locally (.env file) AND in containers / Railway (vars injected, no file).
// Precedence: real process.env wins over .env-file values, so Railway/production vars always override.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(root) {
  let fileEnv = {};
  // read .env.local (this app) or .env (standalone) if present; in prod, process.env carries everything
  for (const name of ['.env.local', '.env']) {
    try {
      const p = join(root, name);
      if (existsSync(p)) {
        fileEnv = {
          ...fileEnv,
          ...Object.fromEntries(
            readFileSync(p, 'utf8').split('\n')
              .filter(l => l.includes('=') && !l.trim().startsWith('#'))
              .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
          ),
        };
      }
    } catch (e) { /* ignore */ }
  }
  return { ...fileEnv, ...process.env };
}
