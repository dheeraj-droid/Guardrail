import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { publishPipelineJob, verifyQStashSignature } from '@/lib/queue/qstash';
import type { QueueEnv } from '@/config/env';
import type { PipelineInput } from '@/types/github';

const CURRENT_KEY = 'current-signing-key';
const NEXT_KEY = 'next-signing-key';

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

/**
 * Build a real QStash-shaped JWT (header.payload.signature) exactly per
 * docs/specs/N-retry-queue.md File 1's algorithm, so these tests exercise the actual
 * verification path, not a stubbed one.
 */
function buildToken(opts: {
  bodyPayload: string; // the raw request body the `body` claim should hash
  signingKey: string;
  claimsOverride?: Record<string, unknown>;
  tamperSignature?: boolean;
}): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const bodyHash = createHash('sha256').update(opts.bodyPayload).digest('base64url');
  const claims: Record<string, unknown> = {
    iss: 'Upstash',
    sub: 'https://example.com/api/webhook/process',
    exp: now + 300,
    nbf: now - 60,
    body: bodyHash,
    ...opts.claimsOverride,
  };

  const headerSegment = b64url(JSON.stringify(header));
  const payloadSegment = b64url(JSON.stringify(claims));

  let signatureSegment = createHmac('sha256', opts.signingKey)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest('base64url');

  if (opts.tamperSignature) {
    const bytes = Buffer.from(signatureSegment, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    signatureSegment = bytes.toString('base64url');
  }

  return `${headerSegment}.${payloadSegment}.${signatureSegment}`;
}

describe('publishPipelineJob', () => {
  const queueEnv: QueueEnv = {
    qstashToken: 'qstash-token',
    qstashCurrentSigningKey: CURRENT_KEY,
    qstashNextSigningKey: NEXT_KEY,
  };
  const input: PipelineInput = {
    installationId: 987,
    backendRepoId: 42,
    backendOwner: 'acme',
    backendRepo: 'backend-repo',
    prNumber: 7,
    headSha: 'headsha123',
    headRef: 'feature/x',
    baseRef: 'main',
  };
  const processUrl = 'https://app.example.com/api/webhook/process';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. success -> exactly one fetch call with the right URL/headers/body', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await publishPipelineJob(queueEnv, processUrl, input);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, requestOpts] = fetchSpy.mock.calls[0]!;
    // Raw, not percent-encoded (confirmed against Upstash's published API docs).
    expect(url).toBe(`https://qstash.upstash.io/v2/publish/${processUrl}`);
    expect(requestOpts).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${queueEnv.qstashToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  });

  it('2. non-2xx response -> throws with the status code in the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));

    await expect(publishPipelineJob(queueEnv, processUrl, input)).rejects.toThrow(/503/);
  });
});

describe('verifyQStashSignature', () => {
  const payload = JSON.stringify({ hello: 'world' });

  it('3. valid signature under the CURRENT key -> true', () => {
    const token = buildToken({ bodyPayload: payload, signingKey: CURRENT_KEY });
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: token,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(true);
  });

  it('4. valid signature under the NEXT key only (key rotation) -> true', () => {
    const token = buildToken({ bodyPayload: payload, signingKey: NEXT_KEY });
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: token,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(true);
  });

  it('5. tampered signature (flipped byte) -> false, never throws', () => {
    const token = buildToken({ bodyPayload: payload, signingKey: CURRENT_KEY, tamperSignature: true });
    let result: boolean | undefined;
    expect(() => {
      result = verifyQStashSignature({
        payload,
        signatureHeader: token,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('6. missing header -> false', () => {
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: null,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: undefined,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
  });

  it('7. malformed JWT (not 3 dot-separated segments) -> false, never throws', () => {
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: 'not-a-jwt-at-all',
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: 'a.b.c.d',
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
  });

  it('8. iss claim wrong -> false, even with a structurally valid signature', () => {
    const token = buildToken({
      bodyPayload: payload,
      signingKey: CURRENT_KEY,
      claimsOverride: { iss: 'NotUpstash' },
    });
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: token,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
  });

  it('9a. exp in the past -> false', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = buildToken({
      bodyPayload: payload,
      signingKey: CURRENT_KEY,
      claimsOverride: { exp: now - 10 },
    });
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: token,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
  });

  it('9b. nbf in the future -> false', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = buildToken({
      bodyPayload: payload,
      signingKey: CURRENT_KEY,
      claimsOverride: { nbf: now + 300 },
    });
    expect(
      verifyQStashSignature({
        payload,
        signatureHeader: token,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
  });

  it('10. body claim does not match sha256(payload) -> false (proves the body-hash check is real)', () => {
    // Token is signed correctly, but its `body` claim hashes a DIFFERENT payload than
    // the one actually passed to verifyQStashSignature — the signature bytes themselves
    // are untouched and valid.
    const token = buildToken({ bodyPayload: 'a completely different original body', signingKey: CURRENT_KEY });
    expect(
      verifyQStashSignature({
        payload, // does not match the body the token's `body` claim was hashed over
        signatureHeader: token,
        currentSigningKey: CURRENT_KEY,
        nextSigningKey: NEXT_KEY,
      }),
    ).toBe(false);
  });

  // 11. Deliberate scope cut, not an oversight: the `sub` claim is never validated here
  // (docs/specs/N-retry-queue.md File 1). Validating it would require threading the
  // receiver's own exact URL through this pure function — an extra deployment-config
  // coupling for marginal security value, since the body-hash + HMAC signature already
  // authenticate that the payload came from someone holding the QStash signing key.
});
