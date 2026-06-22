#!/usr/bin/env bash
# DealFinder one-time setup — installs everything needed to run locally on a fresh machine.
# Usage:  bash setup.sh
set -e
cd "$(dirname "$0")"
echo "=== DealFinder setup ==="

# 1) Node.js check
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed. Install Node 18+ from https://nodejs.org and re-run."
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then echo "❌ Node 18+ required (you have $(node -v))."; exit 1; fi
echo "✓ Node $(node -v)"

# 2) System tools for reading the PDFs: poppler (pdftotext/pdftoppm) + tesseract (OCR)
need_tool() { command -v "$1" >/dev/null 2>&1; }
if ! need_tool pdftotext || ! need_tool tesseract; then
  echo "Installing PDF/OCR tools (poppler + tesseract)…"
  OS="$(uname -s)"
  if [ "$OS" = "Darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "❌ Homebrew not found. Install it from https://brew.sh then re-run, or 'brew install poppler tesseract' manually."
      exit 1
    fi
    brew install poppler tesseract
  elif [ -f /etc/debian_version ]; then
    sudo apt-get update && sudo apt-get install -y poppler-utils tesseract-ocr
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y poppler-utils tesseract
  else
    echo "⚠ Could not auto-install poppler/tesseract on this OS. Install them manually, then re-run."
  fi
fi
need_tool pdftotext && echo "✓ pdftotext" || echo "⚠ pdftotext missing"
need_tool tesseract && echo "✓ tesseract" || echo "⚠ tesseract missing"

# 3) npm dependencies (postinstall also downloads the Camoufox stealth browser)
echo "Installing npm dependencies + Camoufox browser (this can take a few minutes)…"
npm install

# 4) .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ created .env  — OPEN IT and fill in your keys before scanning."
else
  echo "✓ .env already exists"
fi

# 5) database table
if grep -q "YOURPROJECT" .env 2>/dev/null; then
  echo "⏭  Skipping DB setup — fill in .env first, then run:  npm run db:setup"
else
  echo "Creating the Supabase table…"
  npm run db:setup || echo "⚠ DB setup failed — check DIRECT_URL in .env, then run 'npm run db:setup'"
fi

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit .env with your keys (Supabase, CapSolver, Apify, Anthropic)."
echo "  2. If you skipped it:  npm run db:setup"
echo "  3. Start the dashboard:  npm run dev    → http://localhost:3000/foreclosures"
echo "  4. Pull leads:          ./scan.sh        (or click 'Scan' in the dashboard)"
