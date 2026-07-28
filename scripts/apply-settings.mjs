#!/usr/bin/env node
// Reconciler: reads data/scan_settings.json (written by the /settings page) and applies it to the
// live scan runtime — WITHOUT touching daily.mjs:
//   1. enabled_counties -> ENABLED_COUNTIES in .env  (daily.mjs already reads this)
//   2. scan_time + scan_days + timezone -> dealfinder-daily.timer OnCalendar  (systemd)
// Runs as root on a short systemd timer, so a Save on the dashboard takes effect on the next run.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = join(ROOT, 'data', 'scan_settings.json');
const ENV = join(ROOT, '.env');
const TIMER = '/etc/systemd/system/dealfinder-daily.timer';

if (!existsSync(SETTINGS)) { console.log('no scan_settings.json — nothing to apply'); process.exit(0); }
const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));

// 1) ENABLED_COUNTIES -> .env (upsert the line)
if (Array.isArray(s.enabled_counties) && existsSync(ENV)) {
  const want = `ENABLED_COUNTIES=${s.enabled_counties.join(',')}`;
  const lines = readFileSync(ENV, 'utf8').split('\n');
  const i = lines.findIndex(l => l.startsWith('ENABLED_COUNTIES='));
  if (i >= 0) { if (lines[i] !== want) { lines[i] = want; writeFileSync(ENV, lines.join('\n')); console.log('updated', want); } }
  else { lines.push(want); writeFileSync(ENV, lines.join('\n')); console.log('added', want); }
}

// 2) schedule -> systemd OnCalendar
const [hh, mm] = String(s.scan_time || '07:00').split(':');
const dowMap = { daily: '*-*-*', weekdays: 'Mon..Fri' };
let onCal;
if (s.scan_days === 'daily' || !s.scan_days) onCal = `*-*-* ${hh}:${mm}:00`;
else if (s.scan_days === 'weekdays') onCal = `Mon..Fri ${hh}:${mm}:00`;
else {
  const days = String(s.scan_days).split(',').map(d => d.trim().slice(0,3)).map(d => d[0].toUpperCase()+d.slice(1)).join(',');
  onCal = `${days} ${hh}:${mm}:00`;
}
const tz = s.timezone || 'America/New_York';

if (existsSync(TIMER)) {
  const cur = readFileSync(TIMER, 'utf8');
  const next = cur
    .replace(/OnCalendar=.*/g, `OnCalendar=${onCal}`)
    .replace(/(\[Timer\][^\[]*)/, (blk) => /Timezone=/.test(blk) ? blk.replace(/Timezone=.*/, `Timezone=${tz}`) : blk.replace('[Timer]', `[Timer]\nTimezone=${tz}`));
  if (next !== cur) {
    writeFileSync(TIMER, next);
    try { execSync('systemctl daemon-reload && systemctl restart dealfinder-daily.timer', { stdio: 'ignore' }); } catch {}
    console.log('applied schedule:', onCal, tz);
  } else console.log('schedule already current:', onCal, tz);
} else {
  console.log('dealfinder-daily.timer not found — skipping schedule apply');
}
