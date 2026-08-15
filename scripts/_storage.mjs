// Save a foreclosure PDF to Supabase Storage so it stays accessible after the county site's link expires
// (Orange County locks docs ~30 min after a scan). Returns a signed URL, or null on failure.
//
// SECURITY: the bucket is PRIVATE. These PDFs (Complaint, Value-of-Property) carry owner names,
// financials, and full addresses — a public bucket + getPublicUrl let anyone reach them by URL.
// We store into a private bucket and hand back a time-limited signed URL instead.
const BUCKET = 'foreclosure-docs';

// Signed-URL lifetime. Long enough to cover the door-knock window for a scan batch, but the
// bucket is no longer world-readable and object paths are not enumerable/guessable.
// (For short-TTL-on-demand signing, store `path` in the DB and mint a fresh signed URL per view;
//  see notes in the audit — deferred to keep this change contained.)
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// `log` is optional (callers that don't pass one keep the old silent behavior for back-compat),
// but every real call site now passes the scraper's `log()` so a storage failure is LOUD instead
// of a quiet null that upstream code could mistake for "nothing to save" (2026-07-28 bug: every
// county's auction enrichment logged "saved" per-case, then reported 0/N docs saved overall —
// saveDocToStorage was silently failing and nobody could see why).
export async function saveDocToStorage(sb, caseNumber, kind, buffer, log = () => {}) {
  if (!sb || !buffer || !buffer.length) return null;
  const safe = String(caseNumber).replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `${safe}/${kind}.pdf`;
  try {
    // RETRY transient storage failures. Measured on the 2026-08-01 run: 149/388 cases showed as
    // "no document" and the health check blamed the docket fetch — but the docket fetch was fine.
    // The uploads were dying on "The connection to the database timed out", a transient Supabase
    // Storage error that a single attempt turns into permanent data loss: complaint_url stays
    // null, so the case is indistinguishable from one whose document never existed.
    //
    // The other failure, "The object exceeded the maximum allowed size", is NOT transient —
    // Orange complaints reach 16 MB. Retrying that just wastes minutes, so it exits immediately
    // and says so.
    let error = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      ({ error } = await sb.storage.from(BUCKET).upload(path, buffer, { contentType: 'application/pdf', upsert: true }));
      if (!error || /exists|duplicate/i.test(error.message || '')) break;
      const msg = String(error.message || error);
      if (/exceeded the maximum allowed size|too large|payload/i.test(msg)) {
        log(`storage: ${caseNumber} ${kind} TOO LARGE (${(buffer.length / 1048576).toFixed(1)}MB) — not retrying`);
        return null;
      }
      if (attempt < 3) {
        log(`storage: ${caseNumber} ${kind} upload attempt ${attempt}/3 failed (${msg.slice(0, 60)}) — retrying`);
        await new Promise(r => setTimeout(r, attempt * 4000));   // 4s, then 8s
      }
    }
    if (error && !/exists|duplicate/i.test(error.message || '')) {
      log(`storage: ${caseNumber} ${kind} upload FAILED after 3 attempts — ${String(error.message || error).slice(0, 160)}`);
      return null;
    }
    const { data, error: signErr } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signErr) {
      log(`storage: ${caseNumber} ${kind} uploaded but SIGN FAILED — ${String(signErr.message || signErr).slice(0, 160)}`);
      return null;
    }
    return data?.signedUrl || null;
  } catch (e) {
    log(`storage: ${caseNumber} ${kind} upload THREW — ${String(e?.message || e).slice(0, 160)}`);
    return null;
  }
}

// One-time: ensure the PRIVATE bucket exists (called from db-setup).
export async function ensureBucket(sb) {
  try {
    const { error } = await sb.storage.createBucket(BUCKET, { public: false });
    if (error && !/exists/i.test(error.message || '')) return { ok: false, msg: error.message };
    // If the bucket already existed as public (from an earlier build), flip it to private.
    try { await sb.storage.updateBucket(BUCKET, { public: false }); } catch { /* older supabase-js may lack updateBucket */ }
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e.message) }; }
}
