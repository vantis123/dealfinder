#!/usr/bin/env bash
# DealFinder one-line installer.
#   curl -fsSL https://raw.githubusercontent.com/vantis123/dealfinder/main/install.sh | bash
# Clones the repo into ./dealfinder and installs everything (deps, Camoufox, poppler+tesseract).
set -e
REPO="https://github.com/vantis123/dealfinder"
DIR="${DEALFINDER_DIR:-dealfinder}"

echo "╔══════════════════════════════════════╗"
echo "║   Installing DealFinder               ║"
echo "╚══════════════════════════════════════╝"

# prerequisites
command -v git  >/dev/null 2>&1 || { echo "❌ git not found. Install git first: https://git-scm.com"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found. Install Node 18+: https://nodejs.org"; exit 1; }

# clone (or update if it already exists)
if [ -d "$DIR/.git" ]; then
  echo "→ Updating existing $DIR…"; git -C "$DIR" pull --ff-only
else
  echo "→ Cloning into ./$DIR…"; git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
echo "→ Running setup…"
bash setup.sh

echo ""
echo "✅ DealFinder installed in ./$DIR"
echo "   1. cd $DIR"
echo "   2. edit .env with your keys"
echo "   3. npm run dev     (dashboard at http://localhost:3000/foreclosures)"
echo "   4. ./scan.sh       (pull leads)"
