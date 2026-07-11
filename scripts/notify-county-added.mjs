// Sends the branded "your county is live on DealFinder" email via Resend, with a CTA back to the
// dashboard to see the leads. Called by Vantis when a county_request flips to `live`.
//   import { notifyCountyAdded } from './notify-county-added.mjs'
//   await notifyCountyAdded({ county: 'Hillsborough', state: 'FL', to: 'x@y.com' })
// CLI preview:  node scripts/notify-county-added.mjs "Hillsborough" FL you@email.com [fromOverride]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './_env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(ROOT);
const SITE = env.DEAL_FINDER_URL || 'https://web-production-a8fce.up.railway.app';
const BRAND = '#0ea5e9';      // primary — hsl(199 89% 48%)
const INK = '#0b1220';        // near-black brand ink

function emailHtml({ county, state }) {
  const leadsUrl = `${SITE}/foreclosures`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,.08);">
        <!-- header -->
        <tr><td style="background:${INK};padding:20px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:10px;">
              <div style="width:34px;height:34px;background:${BRAND};border-radius:9px;color:${INK};font-weight:800;font-size:20px;text-align:center;line-height:34px;font-family:Arial,sans-serif;">D</div>
            </td>
            <td style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.2px;">DealFinder
              <span style="background:rgba(14,165,233,.18);color:${BRAND};font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;margin-left:4px;">V2</span>
            </td>
          </tr></table>
        </td></tr>
        <!-- hero -->
        <tr><td style="padding:36px 32px 8px;">
          <div style="display:inline-block;background:rgba(14,165,233,.12);color:${BRAND};font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;text-transform:uppercase;letter-spacing:.6px;">Now Live</div>
          <h1 style="margin:16px 0 8px;font-size:26px;line-height:1.25;color:${INK};font-weight:800;">${county} County, ${state} is on DealFinder 🎉</h1>
          <p style="margin:0;font-size:15px;line-height:1.6;color:#475467;">
            We mapped ${county} County's foreclosure records — <b style="color:${INK};">new leads are flowing into your dashboard right now</b>,
            sorted best-deal-first with the property address, the equity spread (value − owed), and the court docs.
          </p>
        </td></tr>
        <!-- CTA -->
        <tr><td style="padding:24px 32px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background:${BRAND};border-radius:10px;">
              <a href="${leadsUrl}" style="display:inline-block;padding:14px 26px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">View your ${county} leads →</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:12px 32px 36px;">
          <p style="margin:0;font-size:13px;line-height:1.6;color:#667085;">
            It re-scans automatically every morning, so your list stays fresh. Nothing else to do — just open the dashboard and start knocking.
          </p>
        </td></tr>
        <!-- footer -->
        <tr><td style="background:#f9fafb;border-top:1px solid #eef0f3;padding:20px 32px;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#98a2b3;">
            DealFinder · Central Florida foreclosure &amp; auction finder<br>
            You're getting this because you requested ${county} County. Sent by support@arvantistech.com.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function notifyCountyAdded({ county, state = 'FL', to, from }) {
  const key = env.RESEND_API_KEY;
  if (!key || !to || !county) return { skipped: true, reason: !key ? 'no RESEND_API_KEY' : (!to ? 'no recipient' : 'no county') };
  const sender = from || env.RESEND_FROM || 'DealFinder <support@arvantistech.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: sender, to,
      subject: `${county} County is now live on DealFinder`,
      html: emailHtml({ county, state }),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...body };
}

// CLI preview
if (import.meta.url === `file://${process.argv[1]}`) {
  const [county = 'Hillsborough', state = 'FL', to = 'pcrivera787@gmail.com', from] = process.argv.slice(2);
  notifyCountyAdded({ county, state, to, from }).then(r => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
}
