// DealFinder guided onboarding — stands up a NEW buyer's own Supabase + keys, ready to scan.
// Walks through each value (with exactly where to find it), writes .env, builds the schema, tests it.
// Run: npm run onboard
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(ROOT, '.env');
const rl = createInterface({ input, output });
const b = s => `\x1b[1m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`, grn = s => `\x1b[32m${s}\x1b[0m`;

// load existing .env so re-runs keep prior answers as defaults
const cur = {};
if (existsSync(ENV)) for (const l of readFileSync(ENV, 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.trim().startsWith('#')) cur[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }

async function ask(key, label, { help, required = true, secret = false } = {}) {
  const def = cur[key] && !/^your-|YOURPROJECT/.test(cur[key]) ? cur[key] : '';
  if (help) console.log(dim(help));
  for (;;) {
    const shown = def ? ` ${dim('[' + (secret ? def.slice(0, 6) + '…' : def) + ']')}` : '';
    const v = (await rl.question(`  ${b(label)}${shown}: `)).trim() || def;
    if (v || !required) return v;
    console.log('  ↳ required — paste the value (or Ctrl+C to quit).');
  }
}

console.log(`\n${b('=== DealFinder onboarding ===')}`);
console.log(`This sets up ${b('your own')} private database + keys. Your leads stay in your account — nobody else can see them.\n`);

console.log(b('STEP 1 — Create your Supabase project (free)'));
console.log(dim('  • Go to https://supabase.com → sign in → "New project". Pick a name + password, region close to you.'));
console.log(dim('  • Wait ~2 min for it to finish provisioning, then come back here.'));
await rl.question('  Press Enter once your project is ready… ');

console.log(`\n${b('STEP 2 — Supabase keys')}  ${dim('(Project → Settings)')}`);
const url = await ask('NEXT_PUBLIC_SUPABASE_URL', 'Project URL', { help: '  Settings → API → "Project URL" (https://xxxx.supabase.co)' });
const anon = await ask('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon public key', { help: '  Settings → API → Project API keys → "anon public"', secret: true });
const svc = await ask('SUPABASE_SERVICE_ROLE_KEY', 'service_role key', { help: '  Settings → API → Project API keys → "service_role" (keep this private)', secret: true });
console.log(dim('  Settings → Database → Connection string → "URI" (Direct connection, port 5432). Replace [YOUR-PASSWORD] with your project password.'));
const direct = await ask('DIRECT_URL', 'Direct connection URI', { secret: true });

console.log(`\n${b('STEP 3 — Scanner API keys')}  ${dim('(each buyer uses their own — keeps usage + billing separate)')}`);
const cap = await ask('CAPSOLVER_API_KEY', 'CapSolver key', { help: '  https://capsolver.com → Dashboard (solves the Orange County captcha)', secret: true });
const apify = await ask('APIFY_API_TOKEN', 'Apify token', { help: '  https://apify.com → Settings → Integrations → API token (Zillow valuation)', secret: true });
const ant = await ask('ANTHROPIC_API_KEY', 'Anthropic key (optional)', { help: '  https://console.anthropic.com → API Keys (fallback OCR for value sheets)', required: false, secret: true });

console.log(`\n${b('STEP 4 — Daily Telegram report (optional)')}`);
console.log(dim('  In Telegram: message @BotFather → /newbot → copy the token. Then message your bot and open'));
console.log(dim('  https://api.telegram.org/bot<TOKEN>/getUpdates to find your chat id. Leave blank to skip.'));
const tgTok = await ask('TELEGRAM_BOT_TOKEN', 'Telegram bot token (optional)', { required: false, secret: true });
const tgChat = tgTok ? await ask('TELEGRAM_CHAT_ID', 'Telegram chat id (optional)', { required: false }) : '';

// write .env (start from .env.example to keep comments/structure, then overlay answers)
let env = existsSync(join(ROOT, '.env.example')) ? readFileSync(join(ROOT, '.env.example'), 'utf8') : '';
const set = (k, v) => { if (v == null) return; const re = new RegExp(`^${k}=.*$`, 'm'); env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + `\n${k}=${v}`; };
set('NEXT_PUBLIC_SUPABASE_URL', url); set('NEXT_PUBLIC_SUPABASE_ANON_KEY', anon); set('SUPABASE_SERVICE_ROLE_KEY', svc); set('DIRECT_URL', direct);
set('CAPSOLVER_API_KEY', cap); set('APIFY_API_TOKEN', apify); set('ANTHROPIC_API_KEY', ant);
set('TELEGRAM_BOT_TOKEN', tgTok); set('TELEGRAM_CHAT_ID', tgChat);
set('ENABLED_COUNTIES', cur.ENABLED_COUNTIES || 'Orange');
writeFileSync(ENV, env);
console.log(grn('\n✓ wrote .env'));

console.log(`\n${b('STEP 5 — Building your database…')}`);
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'db-setup.mjs')], { stdio: 'inherit', cwd: ROOT });
  console.log(grn('✓ database ready (foreclosure_leads table created in your Supabase)'));
} catch (e) {
  console.log('⚠ DB setup failed — double-check DIRECT_URL, then run:  npm run db:setup');
  console.log(dim('  (Or paste db/schema.sql into your Supabase SQL Editor and hit Run.)'));
}

console.log(`\n${b(grn('=== Done — your DealFinder is ready ==='))}`);
console.log('  • Start the dashboard:   npm run dev   → http://localhost:3000/foreclosures');
console.log('  • Pull leads now:        npm run scan   (or click "Scan" in the dashboard)');
console.log('  • Run every morning in the cloud:  see RAILWAY.md');
rl.close();
