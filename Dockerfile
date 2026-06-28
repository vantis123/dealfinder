# DealFinder container — serves the dashboard (web service) AND can run the scrapers/daily cron.
# Bakes in poppler (pdftotext/pdftoppm), tesseract OCR, and the Camoufox stealth browser + libs.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NEXT_TELEMETRY_DISABLED=1

# pdftotext / pdftoppm (poppler) + OCR (tesseract) + base fonts/certs for the browser
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils tesseract-ocr ca-certificates fonts-liberation curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps (build needs dev deps). postinstall fetches the Camoufox browser binary.
COPY package*.json ./
RUN npm ci
# Firefox/Camoufox system libraries (gtk, x11, dbus, etc.)
RUN npx playwright install-deps firefox || true

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Default = the web dashboard. The daily-cron service overrides this with: node scripts/daily.mjs
CMD ["npm", "start"]
