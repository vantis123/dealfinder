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

// The object path is fully deterministic, so it can always be rebuilt from a case number + kind.
// This is what makes an expired signature recoverable — see freshSignedUrl() / resign-doc-urls.mjs.
export function docPath(caseNumber, kind) {
  return `${String(caseNumber).replace(/[^A-Za-z0-9._-]/g, '_')}/${kind}.pdf`;
}

export async function saveDocToStorage(sb, caseNumber, kind, buffer) {
  if (!sb || !buffer || !buffer.length) return null;
  const path = docPath(caseNumber, kind);
  try {
    const { error } = await sb.storage.from(BUCKET).upload(path, buffer, { contentType: 'application/pdf', upsert: true });
    if (error && !/exists|duplicate/i.test(error.message || '')) return null;
    const { data, error: signErr } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signErr) return null;
    return data?.signedUrl || null;
  } catch (e) { return null; }
}

// Mint a FRESH signed URL for a document that is already in the bucket.
//
// WHY (2026-08-11): stored URLs carry a 30-day signature, so every document silently becomes
// un-fetchable 30 days after it is saved — `http 400`. This bit during the backfill: 57 documents
// had dead links while every single file was still present in the bucket (0 missing). A link that
// expires on a schedule is a slow-motion outage, and it looks identical to a missing file.
//
// Anything that READS a stored doc should call this instead of trusting the URL in the DB. Returns
// null only when the object genuinely is not in the bucket — which makes a null meaningful.
export async function freshSignedUrl(sb, caseNumber, kind, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  if (!sb) return null;
  try {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(docPath(caseNumber, kind), ttlSeconds);
    if (error) return null;
    return data?.signedUrl || null;
  } catch (e) { return null; }
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
