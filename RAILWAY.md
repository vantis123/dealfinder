# DealFinder on Railway — always-on daily scan + Telegram report

Runs the foreclosure scan every morning in the cloud (no Mac required) and sends Dyer a Telegram
message listing the new doors worth knocking, with clickable links to the Complaint, Value sheet,
Zillow, and a map.

---

## 1. One-time: create the Telegram bot (≈60 seconds)

1. Open Telegram, message **@BotFather** → send `/newbot`.
2. Give it a name (e.g. `Dyer DealFinder`) and a username ending in `bot`.
3. Copy the **token** it gives you → that's `TELEGRAM_BOT_TOKEN`.
4. Get the **chat id** of where reports should go:
   - For a DM: message your new bot once, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id": ... }`.
   - For a group (so KMK + Dyer both see it): add the bot to the group, send a message,
     then hit the same `getUpdates` URL — the group id is negative (e.g. `-100123...`).
   - That value is `TELEGRAM_CHAT_ID`.

## 2. Deploy to Railway

1. Push this repo to GitHub (it's already `vantis123/dealfinder`).
2. Railway → **New Project → Deploy from GitHub repo** → pick this repo.
   It builds from the `Dockerfile` automatically (poppler, tesseract, and the Camoufox browser
   are baked in).
3. Add the environment variables (Railway → service → **Variables**) — same keys as `.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL`
   - `CAPSOLVER_API_KEY`, `APIFY_API_TOKEN`, `ANTHROPIC_API_KEY`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - `ENABLED_COUNTIES=Orange`  (add `Seminole` once its scraper is wired)
   - optional: `SHEET_WEBHOOK_URL`, `NOTIFY_HEARTBEAT=1`
4. One-time DB prep — make sure the `notified_at` column exists (so each door is reported once):
   run `npm run db:setup` locally against the same Supabase, **or** run this SQL in Supabase:
   ```sql
   alter table foreclosure_leads add column if not exists notified_at timestamptz;
   ```

## 3. Turn the service into a daily cron

In the Railway service → **Settings → Cron Schedule**, set:

```
0 11 * * *
```

That's **11:00 UTC = 7:00 AM Eastern**, every day. Railway runs the image's start command
(`node scripts/daily.mjs`) on that schedule and the process exits when done.

> Cron services should run-and-exit — `railway.json` already sets `restartPolicyType: NEVER`.

## 4. (Optional) Also host the dashboard

Add a **second service** from the same repo for the live CRM board:
- Start command: `npm run build && npm start`
- Same variables (minus the Telegram ones if you like).
- Railway gives it a URL → that's the `/foreclosures` board Dyer can open on his phone.

---

## What runs each morning

`scripts/daily.mjs`:
1. For each ready county in `ENABLED_COUNTIES` → `run-month.mjs` (scrape current month, dedup via
   upsert, download Complaint + Value, extract address + owed) → `value-with-apify.mjs` (Zillow →
   spread → flag `≥ $200K`).
2. `notify-telegram.mjs` → sends the **new** flagged doors (those not yet reported), stamps them
   `notified_at` so they never repeat, and posts a short heartbeat on empty days.

## Adding Seminole later

`scripts/counties.mjs` already holds Seminole's search-form config (NoBot timing captcha — no
CapSolver). What's missing is the results-table / docket / document-link scraper for the ASP.NET
site. Once that teach-session is done and wired, flip `Seminole.scraper` to `'ready'` and add
`Seminole` to `ENABLED_COUNTIES`.
