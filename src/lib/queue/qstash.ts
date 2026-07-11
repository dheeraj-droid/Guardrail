// Track N — Durable Retry Queue (docs/PLAN_V2.md §3, docs/specs/N-retry-queue.md File 1).
//
// No new npm dependency (CLAUDE.md Law 13) — raw `fetch()` + `node:crypto`, mirroring
// `src/lib/crypto/verifySignature.ts`'s HMAC shape exactly. QStash's signature scheme is
// a compact JWT (header.payload.signature); the algorithm below was derived by reading
// QStash's own SDK source (`upstash/sdk-qstash-ts/src/receiver.ts`), not re-derived from
// memory — see docs/specs/N-retry-queue.md File 1 for the exact step-by-step spec this
// implementation follows.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { QueueEnv } from '@/config/env';
import type { PipelineInput } from '@/types/github';

/**
 * Publish a pipeline job to QStash for durable, retried delivery to `processUrl`
 * (the deployment's own /api/webhook/process endpoint, an absolute URL). Throws on any
 * non-2xx response or network error — the caller (handler.ts) decides what a publish
 * failure means for the HTTP response it sends back to GitHub.
 */
export async function publishPipelineJob(
  queueEnv: QueueEnv,
  processUrl: string,
  input: PipelineInput,
): Promise<void> {
  // QStash's publish API takes the destination URL RAW, not percent-encoded (confirmed
  // against Upstash's published curl example: .../v2/publish/https://example.com) —
  // encoding it here would corrupt the destination against the real API.
  const url = `https://qstash.upstash.io/v2/publish/${processUrl}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${queueEnv.qstashToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`QStash publish failed: ${response.status}`);
  }
}

/** Shape of the claims we actually validate (QStash's JWT carries more, but this is all
 * we read — see the spec's deliberate `sub`-non-validation note below). */
interface QStashClaims {
  iss?: unknown;
  exp?: unknown;
  nbf?: unknown;
  body?: unknown;
}

/**
 * HMAC-SHA256 over `${headerSegment}.${payloadSegment}` (the JWS compact-serialization
 * signing input) under `signingKey`, compared in constant time against the token's own
 * signature segment (base64url-decoded to raw bytes). Never throws.
 */
function signatureMatchesKey(
  headerSegment: string,
  payloadSegment: string,
  signatureSegment: string,
  signingKey: string,
): boolean {
  const expected = createHmac('sha256', signingKey)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const received = Buffer.from(signatureSegment, 'base64url');
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}

function stripPadding(value: string): string {
  return value.replace(/=+$/, '');
}

/**
 * Verify a QStash callback's signature header against BOTH the current and next
 * signing key (QStash's documented key-rotation contract — a valid signature under
 * EITHER key passes). Never throws; malformed input returns false, mirroring
 * verifyGithubSignature's contract exactly (Law 4's constant-time spirit extended to
 * this second, separate trust boundary).
 *
 * Deliberately does NOT validate the `sub` claim (docs/specs/N-retry-queue.md File 1) —
 * would require threading the receiver's own exact URL through this pure function, an
 * extra deployment-configuration coupling the body-hash + HMAC signature already make
 * unnecessary: the outer JWT signature plus the `body` claim already authenticate that
 * the payload came from someone holding the QStash signing key. This is a deliberate
 * scope cut, not an oversight.
 */
export function verifyQStashSignature(opts: {
  payload: string;
  signatureHeader: string | null | undefined;
  currentSigningKey: string;
  nextSigningKey: string;
}): boolean {
  const { payload, signatureHeader, currentSigningKey, nextSigningKey } = opts;

  // 1. Missing/empty header -> false.
  if (!signatureHeader) {
    return false;
  }

  // 2. Compact JWT: exactly 3 dot-separated segments.
  const segments = signatureHeader.split('.');
  if (segments.length !== 3) {
    return false;
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];

  // 3-4. Verify under the current key first, then the next key (key rotation).
  const validUnderCurrent = signatureMatchesKey(
    headerSegment,
    payloadSegment,
    signatureSegment,
    currentSigningKey,
  );
  const validUnderNext =
    validUnderCurrent ||
    signatureMatchesKey(headerSegment, payloadSegment, signatureSegment, nextSigningKey);
  if (!validUnderCurrent && !validUnderNext) {
    return false;
  }

  // 5. Decode + validate claims.
  let claims: QStashClaims;
  try {
    const decoded = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    claims = JSON.parse(decoded) as QStashClaims;
  } catch {
    return false;
  }

  if (claims.iss !== 'Upstash') {
    return false;
  }

  const nowSeconds = Date.now() / 1000;
  if (typeof claims.exp !== 'number' || !(claims.exp > nowSeconds)) {
    return false;
  }
  if (typeof claims.nbf !== 'number' || !(claims.nbf < nowSeconds)) {
    return false;
  }

  if (typeof claims.body !== 'string') {
    return false;
  }
  const computedBodyHash = createHash('sha256').update(payload).digest('base64url');
  if (stripPadding(computedBodyHash) !== stripPadding(claims.body)) {
    return false;
  }

  return true;
}
