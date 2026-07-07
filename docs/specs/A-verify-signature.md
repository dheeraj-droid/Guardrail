# Spec A — Webhook Signature Verification

**Wave:** 1 | **Agent:** module-builder | **Depends on:** W0
**Files produced:** `src/lib/crypto/verifySignature.ts`, `tests/crypto/verifySignature.test.ts`

## Purpose
Cryptographic gatekeeper for the webhook route (SRD Module 1): constant-time validation
of GitHub's `X-Hub-Signature-256` header against our `GITHUB_WEBHOOK_SECRET`.

## Public API (exact)
```ts
export function verifyGithubSignature(opts: {
  /** RAW request body exactly as received — string or Buffer. Never re-serialized JSON. */
  payload: string | Buffer;
  /** Value of the X-Hub-Signature-256 header, e.g. "sha256=ab12...". Null if absent. */
  signatureHeader: string | null | undefined;
  secret: string;
}): boolean;
```

## Allowed imports
`node:crypto` only. This file is pure w.r.t. IO: no env access, no logging.

## Implementation steps
1. If `signatureHeader` is null/undefined/empty, or `secret` is empty → return `false`.
2. The header MUST start with the literal prefix `sha256=` (case-sensitive). Otherwise
   return `false`. Strip the prefix; lowercase the remaining hex.
3. Reject non-hex or odd-length remainders → return `false` (guards `Buffer.from` surprises).
4. Compute expected: `createHmac('sha256', secret).update(payload).digest('hex')`.
   If `payload` is a string, update with UTF-8 (default).
5. Convert both hex strings to Buffers. If byte lengths differ → return `false`
   (`timingSafeEqual` THROWS on length mismatch — you must guard first).
6. Return `crypto.timingSafeEqual(expectedBuf, receivedBuf)`.

## Edge rules (MUST)
- Never compare with `===` on the hex strings — Law 4 (timing side channel).
- Never throw: every malformed input path returns `false`.
- Do not trim or normalize the payload in any way.

## Acceptance tests
Use fixed vectors — compute the real HMAC inside the test with node:crypto:
1. Valid signature for payload `'{"zen":"Design for failure."}'`, secret `'s3cr3t'` → true.
2. Same payload, one hex char flipped → false.
3. Header missing (`null`) → false. Header `''` → false.
4. Header without `sha256=` prefix (e.g. `sha1=...`) → false.
5. Header with UPPERCASE hex but correct value → true (lowercasing rule).
6. Different secret → false.
7. Signature of DIFFERENT length (e.g. `sha256=abcd`) → false, and does not throw.
8. Payload as Buffer and as string produce the same result.

## Forbidden
- Any dependency beyond `node:crypto`.
- Logging the secret, the payload, or the signature.
