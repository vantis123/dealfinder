// Auth helpers for the DealFinder web layer.
// Pure, dependency-free, edge-runtime safe (uses only globals: atob, string ops).
// Used by middleware.ts to gate EVERY page + /api/* route behind HTTP Basic auth,
// because those routes run with the Supabase service-role key and expose real owner PII.

/**
 * Length-independent, constant-time-ish string comparison.
 * Avoids leaking match length / early-exit timing on the credential compare.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Fold both into a fixed accumulator; comparing lengths up front is fine
  // (length is not secret here), but we still avoid an early return on content.
  let mismatch = a.length === b.length ? 0 : 1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    mismatch |= a.charCodeAt(i % (a.length || 1)) ^ b.charCodeAt(i % (b.length || 1));
  }
  return mismatch === 0;
}

/**
 * Validate an HTTP `Authorization: Basic <base64>` header against expected creds.
 * FAILS CLOSED: if expectedUser/expectedPass are not configured, no request is
 * ever authorized (the PII DB stays sealed until env vars are set).
 * @param {string|null|undefined} authHeader  raw Authorization header value
 * @param {string|null|undefined} expectedUser
 * @param {string|null|undefined} expectedPass
 * @returns {boolean}
 */
export function checkBasicAuth(authHeader, expectedUser, expectedPass) {
  // Fail closed when unconfigured — do NOT default-allow.
  if (!expectedUser || !expectedPass) return false;
  if (!authHeader || typeof authHeader !== "string") return false;

  const [scheme, encoded] = authHeader.split(" ");
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return false;

  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }

  // Split on the FIRST colon only — passwords may contain colons.
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  // Evaluate both compares (no short-circuit) so a wrong username and a wrong
  // password take the same path.
  const userOk = constantTimeEqual(user, expectedUser);
  const passOk = constantTimeEqual(pass, expectedPass);
  return userOk && passOk;
}
