import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time validation of GitHub's `X-Hub-Signature-256` header against the
 * configured `GITHUB_WEBHOOK_SECRET` (SRD Module 1, CLAUDE.md Law 4).
 *
 * Pure w.r.t. IO: no env access, no logging. Every malformed-input path returns
 * `false` — this function never throws.
 */
export function verifyGithubSignature(opts: {
  /** RAW request body exactly as received — string or Buffer. Never re-serialized JSON. */
  payload: string | Buffer;
  /** Value of the X-Hub-Signature-256 header, e.g. "sha256=ab12...". Null if absent. */
  signatureHeader: string | null | undefined;
  secret: string;
}): boolean {
  const { payload, signatureHeader, secret } = opts;

  // 1. Missing header or missing secret → false.
  if (!signatureHeader || !secret) {
    return false;
  }

  // 2. Header MUST start with the literal `sha256=` prefix (case-sensitive).
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }
  const received = signatureHeader.slice(prefix.length).toLowerCase();

  // 3. Reject non-hex or odd-length remainders (guards Buffer.from surprises).
  if (received.length === 0 || received.length % 2 !== 0 || !/^[0-9a-f]+$/.test(received)) {
    return false;
  }

  // 4. Compute expected HMAC. String payloads update as UTF-8 (Node default).
  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  // 5. Compare as Buffers; guard length mismatch (timingSafeEqual THROWS otherwise).
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(received, 'hex');
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  // 6. Constant-time comparison (Law 4 — never `===` on the hex strings).
  return timingSafeEqual(expectedBuf, receivedBuf);
}
