// Server-side stale-while-revalidate cache for DB-backed GET routes.
//
// WHY THIS EXISTS (2026-08-07): Supabase's own internal metrics/monitoring
// backend (application_name=postgres_exporter, an internal role with
// SUPERUSER that we cannot cancel/terminate — verified via pg_cancel_backend
// returning "permission denied ... roles with SUPERUSER") periodically runs a
// heavy aggregate query against extensions.pg_stat_statements that saturates
// this project's small Postgres compute. While that query is running, EVERY
// query on this DB — including `select 1` and reads against 757-row tables —
// takes 8-30s+ or times out, regardless of app-side query design or indexes.
// This is an upstream platform issue, not fixable from application code.
//
// This cache makes the dashboard resilient to that upstream stall: once we
// have one good read, we keep serving it (marking it `stale` after TTL) while
// a background refresh races the slow DB, instead of making every browser
// tab pay the full multi-second-to-timeout tax on every request.
//
// Process-lifetime in-memory cache — valid because dealfinder-web runs as a
// long-lived systemd service (not a serverless/Lambda cold-start-per-request
// model), so the Map survives across requests.

type Entry<T> = { data: T; ts: number; refreshing: boolean };

const store = new Map<string, Entry<unknown>>();

export interface CachedResult<T> {
  data: T;
  stale: boolean;
}

/**
 * Serve `key` from cache if fresh (< ttlMs old).
 * If stale-but-present: return the stale value immediately and kick off a
 * deduped background refresh.
 * If never cached: await the fetcher, but bounded by hardTimeoutMs so a
 * hung upstream can't hang the request forever.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  hardTimeoutMs = 10000
): Promise<CachedResult<T>> {
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;

  const refresh = async (): Promise<T> => {
    if (entry) entry.refreshing = true;
    try {
      const data = await fetcher();
      store.set(key, { data, ts: Date.now(), refreshing: false });
      return data;
    } catch (e) {
      const cur = store.get(key) as Entry<T> | undefined;
      if (cur) cur.refreshing = false;
      throw e;
    }
  };

  if (entry && now - entry.ts < ttlMs) {
    return { data: entry.data, stale: false };
  }

  if (entry) {
    if (!entry.refreshing) {
      // fire-and-forget background refresh; never let it throw unhandled
      refresh().catch(() => {});
    }
    return { data: entry.data, stale: true };
  }

  // Cold cache — must wait for a real answer, but bound the wait.
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("upstream-timeout")), hardTimeoutMs);
  });
  const data = await Promise.race([refresh(), timeout]);
  return { data, stale: false };
}

/** Read whatever is cached right now without triggering a fetch (for error fallbacks). */
export function peek<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined;
}
