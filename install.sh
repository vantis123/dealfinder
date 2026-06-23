#!/usr/bin/env bash
# DealFinder one-line installer — installs Node automatically, no git required.
#   curl -fsSL https://raw.githubusercontent.com/vantis123/dealfinder/main/install.sh | bash
set -e
DIR="${DEALFINDER_DIR:-dealfinder}"
TARBALL="https://github.com/vantis123/dealfinder/archive/refs/heads/main.tar.gz"

echo "╔══════════════════════════════════════╗"
echo "║   Installing DealFinder               ║"
echo "╚══════════════════════════════════════╝"

# 1) Node.js — auto-install via nvm if missing or too old (no sudo / admin password needed)
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    MAJ=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$MAJ" -ge 18 ]; then echo "✓ Node $(node -v)"; return; fi
    echo "→ Node is too old ($(node -v)); installing a newer version via nvm…"
  else
    echo "→ Node.js not found — installing it automatically via nvm…"
  fi
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install --lts >/dev/null
  nvm use --lts >/dev/null
  echo "✓ Node $(node -v) installed (via nvm)"
}
ensure_node

# 2) download the repo (tarball — no git needed)
echo "→ Downloading DealFinder into ./$DIR…"
rm -rf "$DIR" .dealfinder_tmp
mkdir -p .dealfinder_tmp
curl -fsSL "$TARBALL" | tar xz -C .dealfinder_tmp
mv .dealfinder_tmp/dealfinder-* "$DIR"
rm -rf .dealfinder_tmp

# 3) install dependencies + tools
cd "$DIR"
echo "→ Running setup…"
bash setup.sh

echo ""
echo "✅ DealFinder installed in ./$DIR"
echo "   1. cd $DIR"
echo "   2. edit .env with your keys"
echo "   3. npm run dev     (dashboard at http://localhost:3000/foreclosures)"
echo "   4. ./scan.sh       (pull leads)"
