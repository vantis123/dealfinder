# DealFinder — buyer setup (15 minutes, your own private account)

Everything runs on **your own** accounts. Your leads live in **your** database — the seller and other
buyers can't see them, and you can't see theirs. This is by design.

## 1. Install DealFinder

```bash
curl -fsSL https://raw.githubusercontent.com/vantis123/dealfinder/main/install.sh | bash
cd dealfinder
bash setup.sh        # installs Node, the browser, and the PDF/OCR tools
```

## 2. Run the guided setup

```bash
npm run onboard
```

It walks you through, step by step:

1. **Create a free Supabase project** — `https://supabase.com` → New project (this is your private database).
2. **Paste 4 Supabase values** — it tells you exactly where each one is:
   - Project URL & keys: **Settings → API**
   - Direct connection string: **Settings → Database → Connection string → URI**
3. **Paste your scanner keys** — each buyer uses their own so usage/billing stays separate:
   - **CapSolver** (`capsolver.com`) — solves the county captcha
   - **Apify** (`apify.com` → Settings → Integrations) — Zillow valuation
   - **Anthropic** (`console.anthropic.com`) — optional, fallback OCR
4. **Telegram** (optional) — for the daily door-knock report.

It writes your `.env`, **builds your database automatically**, and tests the connection. When it finishes
you're ready.

> Prefer to do the database by hand? Open your Supabase project → **SQL Editor** → paste the contents of
> [`db/schema.sql`](db/schema.sql) → **Run**. Same result.

## 3. Use it

```bash
npm run dev        # dashboard at http://localhost:3000/foreclosures
npm run scan       # pull this month's leads (or click "Scan" in the dashboard)
```

## 4. Run it every morning in the cloud (optional)

So it scans daily and texts you the new door-knock leads without your computer being on — see
[`RAILWAY.md`](RAILWAY.md).

---

### Why your own Supabase?

If everyone shared one database, every buyer would see everyone else's deals, and the shared admin key
would expose far more than leads. Giving you **your own** project keeps your pipeline private and secure.
The `onboard` wizard makes standing it up a 2-minute step instead of a chore.
