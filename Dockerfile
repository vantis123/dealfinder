# DealFinder container — serves the dashboard (web service) AND can run the scrapers/daily cron.
# Bakes in poppler (pdftotext/pdftoppm), tesseract OCR, and the Camoufox stealth browser + libs.
# Node 22+ required: the Supabase client needs native WebSocket (absent in Node 20).
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NEXT_TELEMETRY_DISABLED=1

# pdftotext / pdftoppm (poppler) + OCR (tesseract) + fonts/certs + python3/build-essential
# (node-gyp needs them to compile native deps like better-sqlite3 pulled in by the browser lib).
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils tesseract-ocr ca-certificates fonts-liberation curl \
      python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps (build needs dev deps). postinstall ALSO tries to fetch Camoufox but with `|| true`,
# which silently shipped images with no browser (-> runtime CamoufoxNotInstalled, all auction scans failed).
COPY package*.json ./
RUN npm ci
# Firefox/Camoufox system libraries (gtk, x11, dbus, etc.)
RUN npx playwright install-deps firefox || true
# Bake the Camoufox stealth browser into a STABLE image path (not ephemeral $HOME) and FAIL the build if
# the download breaks — so we never again ship an image whose auction scraper can't launch. The runtime
# reads the same CAMOUFOX_INSTALL_DIR env, so scripts/run-realforeclose.mjs finds it.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN node node_modules/camoufox-js/dist/__main__.js fetch \
  && test -d /opt/camoufox && ls -la /opt/camoufox

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Default = the web dashboard. The daily-cron service overrides this with: node scripts/daily.mjs
CMD ["npm", "start"]
