// Shared env loader — works locally (.env file) AND in containers / Railway (vars injected, no file).
// Precedence: real process.env wins over .env-file values, so Railway/production vars always override.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(root) {
  let fileEnv = {};
  try {
    const p = join(root, '.env');
    if (existsSync(p)) {
      fileEnv = Object.fromEntries(
        readFileSync(p, 'utf8').split('\n')
          .filter(l => l.includes('=') && !l.trim().startsWith('#'))
          .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
      );
    }
  } catch (e) { /* no .env in production — process.env carries everything */ }
  return { ...fileEnv, ...process.env };
}
