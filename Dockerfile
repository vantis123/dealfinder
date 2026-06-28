# DealFinder — container image for Railway (daily cron) and the dashboard.
# Bakes in everything the scraper needs: poppler (pdftotext/pdftoppm), tesseract OCR,
# and the Camoufox (Firefox) stealth browser + its system libraries.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive

# pdftotext / pdftoppm (poppler) + OCR (tesseract) + base fonts/certs for the browser
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      ca-certificates \
      fonts-liberation \
      curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). postinstall fetches the Camoufox browser binary.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Firefox/Camoufox system libraries (gtk, x11, dbus, etc.) via Playwright's dependency installer.
RUN npx playwright install-deps firefox || true

COPY . .

# Default = the daily run. The Railway Cron service uses this; a separate web service overrides
# the start command with `npm run build && npm start` to serve the dashboard.
CMD ["node", "scripts/daily.mjs"]
