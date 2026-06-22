# DealFinder — Foreclosure Door-Knock Lead Finder

Finds Orange County, FL foreclosure filings worth door-knocking: it reads each case's
**Complaint** (property address) and **Value of Real Property** (amount owed), pulls the
**Zillow value**, computes the **equity spread** (value − owed), and flags anything with a
spread ≥ **$200,000** as a "KNOCK" lead. Results show up in a live **CRM dashboard**, a
**Google Sheet**, and a **door-knock CSV**.

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

## Setup (one time, ~5 minutes)

```bash
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
scripts/run-month.mjs        the scanner (scrape clerk → docs → address/owed)
scripts/value-with-apify.mjs Zillow valuation (Apify) → spread/worth-it → sheet + CSV
scripts/db-setup.mjs         creates the Supabase table
app/                         the Next.js CRM dashboard
.env.example                 copy to .env and fill in keys
setup.sh                     one-time installer
scan.sh                      "Refresh Leads" launcher
```

## Google Sheet sync (optional)
Set `SHEET_WEBHOOK_URL` in `.env` to an n8n (or Apps Script) webhook that appends a row per
lead. Leave it blank to skip — the dashboard + CSV work without it.
