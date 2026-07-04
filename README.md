# DealFinder — Foreclosure Door-Knock Lead Finder

Finds Central Florida foreclosure deals worth door-knocking from **two sources**:

- **Pre-foreclosure** — county clerk lis-pendens filings (early; door-knock the owner). Live in
  all **7 Greater Central FL counties**: Orange, Seminole, Lake, Polk, Volusia, Brevard, Osceola.
- **Auctions** — RealForeclose scheduled sales (urgent; clock ticking). Live in **Seminole,
  Orange, Volusia, Polk**.

For each case it pulls the **property address** and **amount owed** straight from the county
paperwork (Complaint / Final Judgment / Value sheet), gets the **Zillow value**, computes the
**equity spread** (value − owed), and flags the worth-it ones. Everything lands in a live **CRM
pipeline** (Foreclosures, Auctions, and a Kanban board with per-county filters + door-knock
routing), plus an optional **Google Sheet** and **CSV**.

This is a **self-contained** copy — you don't need any other repo. Follow the steps below on
any Mac or Linux machine.

---

## What you need first (one-time accounts)

| Service | What it's for | Free? |
|---|---|---|
| [Supabase](https://supabase.com) | stores all the leads (the database) | yes |
| [CapSolver](https://capsolver.com) | solves the county clerk's captcha | pay-as-you-go (cheap) |
| [Apify](https://apify.com) | reliable Zillow values (no IP blocking) | ~$0.36 per full month |
| [Anthropic](https://console.anthropic.com) | reads scrambled-font "Value" PDFs | pay-as-you-go (optional) |

You'll paste an API key from each into `.env`.

---

## Install (one command)

Paste this into a terminal — it clones the repo and installs everything (Node packages,
the Camoufox browser, and the PDF/OCR tools):

```bash
curl -fsSL https://raw.githubusercontent.com/vantis123/dealfinder/main/install.sh | bash
```

It installs **Node.js automatically** (via nvm, no admin password) and downloads everything —
you don't need git or Node beforehand. Then `cd dealfinder`, fill in `.env`, and you're ready.

> On Mac it also installs Homebrew + the PDF tools automatically. If your Mac asks for your
> password during the Homebrew step, that's the one manual moment — enter it once.

---

## Setup (manual alternative)

```bash
git clone https://github.com/vantis123/dealfinder
cd dealfinder
bash setup.sh
```

This installs Node packages, the Camoufox stealth browser, and the PDF/OCR tools
(`poppler` + `tesseract`). Then:

1. **Open `.env`** and fill in your keys (it was created from `.env.example`).
2. Create the database table (if setup skipped it):
   ```bash
   npm run db:setup
   ```

> **Requirements:** Node 18+ and, on Mac, [Homebrew](https://brew.sh) (for the PDF tools).
> The setup script installs everything else.

---

## Daily use

**See the leads (CRM dashboard):**
```bash
npm run dev
```
Open **http://localhost:3000/foreclosures** — worth-it leads sort to the top with address,
spread, Map/Street-View + Zillow links, document links, and a door-knock status dropdown.

**Pull a month of leads (the scan):**
```bash
./scan.sh            # current month
./scan.sh 6 2026     # a specific month/year
```
…or just click **"Scan"** in the dashboard and pick a month.

A scan: searches the clerk → reads each case's Complaint + Value docs → extracts address & owed
→ values every property via Apify → writes everything to Supabase, the Google Sheet (if
configured), and `door-knock-leads.csv`. A full month is ~50–90 minutes.

---

## Who runs what

- **You / an operator** run the **scan** on a real computer (it needs a browser + your home
  internet + the API keys). Door-knockers do **not** run scans.
- **Door-knockers** just open the **dashboard link** or the **Google Sheet** on their phone —
  they see the address list, spreads, and Street-View links. No setup on their end.

> The scan **cannot** run on Vercel/serverless (it needs a real browser, long runtime, and a
> residential IP). Keep it on a Mac/PC; the dashboard + sheet are what you share.

---

## Files

```
scripts/daily.mjs            the daily cron — runs every county (pre-foreclosure + auction) + Telegram report
scripts/run-month.mjs        Orange pre-foreclosure (myeclerk / reCAPTCHA)
scripts/run-seminole.mjs     Seminole pre-foreclosure (CiviTek / NoBot)
scripts/run-lake.mjs         Lake pre-foreclosure (equivant ShowCase)
scripts/run-brevard.mjs      Brevard pre-foreclosure (BECA / ColdFusion)
scripts/run-volusia.mjs      Volusia pre-foreclosure (weekly report + ccms)
scripts/run-osceola.mjs      Osceola pre-foreclosure (Pioneer Benchmark)
scripts/run-polk.mjs         Polk pre-foreclosure (PRO / reCAPTCHA)
scripts/run-realforeclose.mjs auction scanner — Seminole, Orange, Volusia, Polk
scripts/clerk-enrich.mjs     pulls the auction Final Judgment / Value Sheet PDF
scripts/normalize-deals.mjs  rebuilds the unified CRM `deals` spine from both sources
scripts/notify-telegram.mjs  the daily report, grouped by county
scripts/value-with-apify.mjs Zillow valuation (Apify) → spread/worth-it
scripts/db-setup.mjs         creates the Supabase tables
app/                         the Next.js CRM (Foreclosures, Auctions, Pipeline board)
lib/counties.ts              canonical county coverage the UI dropdowns read from
.env.example                 copy to .env and fill in keys
setup.sh / scan.sh           one-time installer / scan launcher
```

> **Node version:** the dashboard runs on Node 18+, but the **scrapers need Node 24** (the
> Camoufox stealth browser requires it). If a scan errors on startup, check `node --version`.

## Google Sheet sync (optional)
Set `SHEET_WEBHOOK_URL` in `.env` to an n8n (or Apps Script) webhook that appends a row per
lead. Leave it blank to skip — the dashboard + CSV work without it.
