import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { makePostHandler } from '@/app/api/github/marketplace/handler';
import type { MarketplaceEnv } from '@/config/env';

const SECRET = 'test-marketplace-secret';

function sign(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

function fakeMarketplaceEnv(): MarketplaceEnv {
  return { webhookSecret: SECRET };
}

function makeRequest(opts: {
  body: string;
  signature?: string | null;
  contentLength?: string | null;
}): Request {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  // Node's Request does not auto-populate Content-Length from a string body, and the
  // handler requires it (body-size guard, T3-parity). Default to the real byte length; a
  // test can override (or pass null to omit it) to exercise the guard.
  if (opts.contentLength !== null) {
    headers.set('content-length', opts.contentLength ?? String(Buffer.byteLength(opts.body)));
  }
  if (opts.signature !== null) {
    headers.set('x-hub-signature-256', opts.signature ?? sign(opts.body, SECRET));
  }
  return new Request('http://localhost/api/github/marketplace', {
    method: 'POST',
    headers,
    body: opts.body,
  });
}

const MARKETPLACE_PAYLOAD = JSON.stringify({
  action: 'purchased',
  marketplace_purchase: { account: { login: 'acme' }, plan: { name: 'Pro' } },
});

describe('POST /api/github/marketplace', () => {
  it('M1. valid signature -> 200 {ok:true}', async () => {
    const handler = makePostHandler({ marketplaceEnv: fakeMarketplaceEnv() });
    const res = await handler(makeRequest({ body: MARKETPLACE_PAYLOAD }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('M2. bad signature -> 401', async () => {
    const handler = makePostHandler({ marketplaceEnv: fakeMarketplaceEnv() });
    const res = await handler(
      makeRequest({ body: MARKETPLACE_PAYLOAD, signature: sign(MARKETPLACE_PAYLOAD, 'wrong-secret') }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid signature' });
  });

  it('M3. missing signature header -> 401', async () => {
    const handler = makePostHandler({ marketplaceEnv: fakeMarketplaceEnv() });
    const res = await handler(makeRequest({ body: MARKETPLACE_PAYLOAD, signature: null }));

    expect(res.status).toBe(401);
  });

  it('M4. unconfigured (no marketplace secret) -> 503, never a silent unverified 200', async () => {
    // No override AND no env configured: tryLoadMarketplaceEnv() returns undefined. This
    // relies on GITHUB_MARKETPLACE_WEBHOOK_SECRET being unset in the test process env.
    const previous = process.env.GITHUB_MARKETPLACE_WEBHOOK_SECRET;
    delete process.env.GITHUB_MARKETPLACE_WEBHOOK_SECRET;
    try {
      const handler = makePostHandler();
      const res = await handler(makeRequest({ body: MARKETPLACE_PAYLOAD }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'marketplace not configured' });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_MARKETPLACE_WEBHOOK_SECRET;
      else process.env.GITHUB_MARKETPLACE_WEBHOOK_SECRET = previous;
    }
  });

  it('M5. oversized body (Content-Length beyond cap) -> 413, before verify/read', async () => {
    const handler = makePostHandler({ marketplaceEnv: fakeMarketplaceEnv() });
    const res = await handler(
      makeRequest({ body: MARKETPLACE_PAYLOAD, contentLength: '999999999999' }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload too large' });
  });

  it('M6. missing / malformed Content-Length -> 413', async () => {
    const handler = makePostHandler({ marketplaceEnv: fakeMarketplaceEnv() });

    const missing = await handler(makeRequest({ body: MARKETPLACE_PAYLOAD, contentLength: null }));
    expect(missing.status).toBe(413);

    const malformed = await handler(makeRequest({ body: MARKETPLACE_PAYLOAD, contentLength: '12x' }));
    expect(malformed.status).toBe(413);
  });
});
