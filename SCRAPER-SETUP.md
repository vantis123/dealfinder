# Run the DealFinder scraper on your computer

You're going to run the part of DealFinder that **finds the deals** — it checks the county
foreclosure records every morning and adds new leads to the shared dashboard. It runs by itself
as long as your computer is on.

> **You need an Apple-Silicon Mac** (M1/M2/M3/M4). The stealth browser it uses doesn't have a
> Windows or Intel-Mac build right now. If that's a problem, tell the person who sent you this.

---

## 1. Install (one time, ~10 minutes)

Open the **Terminal** app and paste these one at a time:

```bash
git clone https://github.com/vantis123/dealfinder
cd dealfinder
bash setup.sh
```

`setup.sh` installs everything: Node, the stealth browser, and the PDF tools. If your Mac asks
for your password once (for Homebrew), that's normal — type it and continue.

## 2. Add your keys (one time)

The person who sent you this will give you a filled-in **`.env`** file (or the values to paste).
Open the `.env` file in the `dealfinder` folder and paste them in. These keys are what let the
scraper read the records and write leads to the shared dashboard.

Test that it's working — run one scan by hand:

```bash
npm run daily
```

You'll see it open, read the county sites, and finish with a summary. New leads show up on the
dashboard. (First run downloads the browser, so it takes a few extra minutes.)

## 3. Make it automatic (one time)

```bash
bash scripts/install-schedule.sh
```

That's it. From now on it runs **every morning at 7 AM** on its own — you don't touch anything.
Just leave your Mac on (plugged in, lid can be closed if you set "prevent sleeping"). If the Mac
was asleep at 7, it catches up the next time it wakes.

- Change the time: `bash scripts/install-schedule.sh 6 30` (that's 6:30 AM).
- See what it did: open the `daily-cron.log` file in the `dealfinder` folder.
- Stop it: `launchctl unload ~/Library/LaunchAgents/com.arvantis.dealfinder-daily.plist`

---

## That's the whole job

Leave it running. The dashboard (a website link you'll be given) shows every lead it finds,
sorted by the best deals. You don't need to open Terminal again unless something looks off — in
which case, send whoever set this up the last part of `daily-cron.log`.
