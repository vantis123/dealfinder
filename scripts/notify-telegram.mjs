// Daily Telegram report — sends the NEW door-knock leads (flagged & not yet reported) as a clean
// message with CLICKABLE links to the Complaint, the Value sheet, Zillow, and the map. Each lead is
// stamped notified_at so it is never reported twice. Sends a short heartbeat when there's nothing new
// so Dyer knows the bot ran.
//
// Run standalone:  node scripts/notify-telegram.mjs
// Or import:       import { notifyTelegram } from './notify-telegram.mjs'
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, (optional) NOTIFY_COUNTY, NOTIFY_HEARTBEAT=0 to silence empties.
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtK = n => {
  const v = Number(n);
  if (!v) return '?';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + Math.round(v);
};
const zillowUrl = a => 'https://www.zillow.com/homes/' +
  encodeURIComponent(String(a || '').replace(/\bAlt\.?\s*/ig, 'Alternate ').replace(/[#.]/g, '').replace(/,/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')) + '_rb/';
const mapUrl = a => 'https://www.google.com/maps?q=' + encodeURIComponent(a || '');
const streetViewUrl = a => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a || '');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = d => `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`;
// strip HTML for a readable terminal preview (link labels stay so you can see the tappable words)
const toPlain = s => s.replace(/<a\s[^>]*>(.*?)<\/a>/gi, '$1').replace(/<\/?b>/gi, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function leadBlock(r, i) {
  const addr = r.property_address || '(address pending)';
  const links = [];
  if (r.property_address) links.push(`<a href="${esc(streetViewUrl(addr))}">🗺 Map</a>`);
  if (r.property_address) links.push(`<a href="${esc(zillowUrl(addr))}">🏠 Zillow</a>`);
  if (r.complaint_url) links.push(`<a href="${esc(r.complaint_url)}">📄 Complaint</a>`);
  if (r.value_url) links.push(`<a href="${esc(r.value_url)}">💵 Value</a>`);
  if (r.docket_url) links.push(`<a href="${esc(r.docket_url)}">⚖️ Docket</a>`);
  let own = String(r.defendant || '').replace(/\s+/g, ' ').replace(/\s*et\.?\s*al\.?/i, ' et al.').trim();
  if (own.length > 38) own = own.slice(0, 38).replace(/[\s,]+$/, '') + '…';
  const owner = own ? ` · 👤 ${esc(own)}` : '';
  return [
    `<b>${i + 1}. ${fmtK(r.spread)} spread</b>`,
    `📍 ${esc(addr)}`,
    `💰 owed ${fmtK(r.owed_with_buffer)} → Zillow ${fmtK(r.zillow_value)}${owner}`,
    `<i>${esc(r.county || 'Orange')} · ${esc(r.case_number)}</i>`,
    links.join('  ·  '),
  ].join('\n');
}

// Build the full report (header + numbered leads + total equity) → Telegram-sized message chunks.
function buildReport(leads, when) {
  const n = leads.length;
  const header = `🚪 <b>${n} new door${n > 1 ? 's' : ''} to knock</b> — ${niceDate(when)}`;
  const total = leads.reduce((s, r) => s + (Number(r.spread) || 0), 0);
  const footer = `💰 Total new equity in play: <b>${fmtK(total)}</b>`;
  return chunk(header, leads.map(leadBlock), footer);
}

async function send(token, chat, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).then(r => r.json()).catch(e => ({ ok: false, description: String(e) }));
  if (!res.ok) console.log('  telegram send error:', res.description || res);
  return res.ok;
}

// Split into <4096-char Telegram messages on lead boundaries.
function chunk(header, blocks, footer) {
  const msgs = [];
  let cur = header;
  for (const b of blocks) {
    if ((cur + '\n\n' + b).length > 3800) { msgs.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + b;
  }
  if (footer) cur += '\n\n' + footer;
  if (cur) msgs.push(cur);
  return msgs;
}

export async function notifyTelegram({ token, chat, county, preview = false, mark = true } = {}) {
  token = token || env.TELEGRAM_BOT_TOKEN;
  chat = chat || env.TELEGRAM_CHAT_ID;
  county = county || env.NOTIFY_COUNTY || null;
  preview = preview || process.env.PREVIEW === '1' || process.argv.includes('--preview');
  const doMark = mark && !process.argv.includes('--example'); // --example sends without stamping notified_at
  const heartbeat = (env.NOTIFY_HEARTBEAT ?? '1') !== '0';

  if (!preview && (!token || !chat)) { console.log('telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping (run with --preview to SEE the report)'); return { sent: 0, skipped: true }; }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let q = sb.from('foreclosure_leads').select('*').eq('flagged', true).is('notified_at', null)
    .order('spread', { ascending: false, nullsFirst: false });
  if (county) q = q.eq('county', county);
  const lim = parseInt(process.env.NOTIFY_LIMIT || '0', 10);
  if (lim) q = q.limit(lim);
  const { data, error } = await q;
  if (error) {
    console.log('telegram: query failed —', error.message);
    if (/notified_at/.test(error.message)) console.log('  → add the column:  alter table foreclosure_leads add column notified_at timestamptz;');
    return { sent: 0, error: error.message };
  }
  let leads = data || [];
  let sample = false;

  // Preview with nothing newly-flagged? Show the current top flagged leads (or top by spread) so the
  // FORMAT is visible without sending or marking anything.
  if (preview && !leads.length) {
    const top = async (b) => { let s = b.order('spread', { ascending: false, nullsFirst: false }).limit(5); if (county) s = s.eq('county', county); return (await s).data || []; };
    leads = await top(sb.from('foreclosure_leads').select('*').eq('flagged', true));
    if (!leads.length) leads = await top(sb.from('foreclosure_leads').select('*').not('property_address', 'is', null));
    sample = leads.length > 0;
  }

  const when = new Date();

  if (!leads.length) {
    const msg = `✅ <b>DealFinder</b> ran ${niceDate(when)} — no new doors worth knocking today.`;
    if (preview) { console.log('\n----- PREVIEW (quiet day) -----\n' + toPlain(msg) + '\n'); return { preview: true, leads: 0 }; }
    if (heartbeat) await send(token, chat, msg);
    return { sent: 0 };
  }

  const messages = buildReport(leads, when);

  if (preview) {
    console.log(`\n================= DAILY DOOR-KNOCK REPORT — PREVIEW${sample ? ' (sample: current top leads)' : ''} =================\n`);
    console.log(messages.map(toPlain).join('\n\n— — — — — (continues in next message) — — — — —\n\n'));
    console.log(`\n================= end · ${leads.length} lead(s) · every link is tappable in Telegram =================\n`);
    return { preview: true, leads: leads.length, sample };
  }

  let ok = true;
  for (const m of messages) ok = (await send(token, chat, m)) && ok;
  if (ok && doMark) {
    await sb.from('foreclosure_leads').update({ notified_at: new Date().toISOString() }).in('case_number', leads.map(l => l.case_number));
  }
  return { sent: ok ? leads.length : 0, total: leads.length, marked: doMark };
}

// Run directly?  (add --preview to print the report instead of sending it)
if (process.argv[1] && process.argv[1].endsWith('notify-telegram.mjs')) {
  notifyTelegram()
    .then(r => { console.log('result:', JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('report failed:', e); process.exit(1); });
}
