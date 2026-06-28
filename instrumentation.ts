// Daily scheduler — runs inside the always-on web service so the morning scan + Telegram report fire
// automatically (no separate Railway cron service needed). Next.js calls register() once on server boot.
// Fires daily.mjs at DAILY_HOUR_UTC (default 11:00 UTC = 7:00am ET). Disable with DISABLE_DAILY_CRON=1.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;          // skip edge runtime
  if (process.env.NODE_ENV !== "production") return;          // don't scan during local `npm run dev`
  if (process.env.DISABLE_DAILY_CRON === "1") return;

  const { spawn } = await import("node:child_process");
  const { join } = await import("node:path");
  const HOUR_UTC = parseInt(process.env.DAILY_HOUR_UTC || "11", 10);

  const msUntilNext = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), HOUR_UTC, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  };

  let running = false;
  const schedule = () => {
    const ms = msUntilNext();
    console.log(`[daily-cron] next run in ~${(ms / 3600000).toFixed(1)}h (at ${HOUR_UTC}:00 UTC)`);
    setTimeout(() => {
      if (!running) {
        running = true;
        console.log("[daily-cron] starting daily.mjs");
        const child = spawn("node", [join(process.cwd(), "scripts", "daily.mjs")], { stdio: "inherit", env: process.env });
        child.on("exit", (code) => { running = false; console.log("[daily-cron] daily.mjs exited", code); });
      }
      schedule(); // reschedule for the next day
    }, ms);
  };
  schedule();
}
