// Save a foreclosure PDF to Supabase Storage so it stays accessible after the county site's link expires
// (Orange County locks docs ~30 min after a scan). Returns a permanent public URL, or null on failure.
const BUCKET = 'foreclosure-docs';

export async function saveDocToStorage(sb, caseNumber, kind, buffer) {
  if (!sb || !buffer || !buffer.length) return null;
  const safe = String(caseNumber).replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `${safe}/${kind}.pdf`;
  try {
    const { error } = await sb.storage.from(BUCKET).upload(path, buffer, { contentType: 'application/pdf', upsert: true });
    if (error && !/exists|duplicate/i.test(error.message || '')) return null;
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (e) { return null; }
}

// One-time: ensure the public bucket exists (called from db-setup).
export async function ensureBucket(sb) {
  try {
    const { error } = await sb.storage.createBucket(BUCKET, { public: true });
    if (error && !/exists/i.test(error.message || '')) return { ok: false, msg: error.message };
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e.message) }; }
}
