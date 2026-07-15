// T5 — GitHub Marketplace webhook receiver, handler factory.
//
// WHY this is split out of route.ts: a Next.js App Router `route.ts` may ONLY export the
// HTTP method handlers (GET/POST/…) and route-segment config. `next build` generates a
// route-type check that FAILS on any other export. The testing seam `makePostHandler` is
// exactly such an extra export, so it lives here and route.ts imports it — mirroring
// src/app/api/webhook/github/handler.ts.
//
// THIN shell: reject oversized bodies, verify the Marketplace HMAC (Law 4, its OWN secret
// — GITHUB_MARKETPLACE_WEBHOOK_SECRET, distinct from the webhook GITHUB_WEBHOOK_SECRET),
// and 200. There is no downstream pipeline yet: Marketplace `purchase`/`change`/`cancel`
// events are acknowledged so GitHub stops retrying. Unconfigured deployments (no secret)
// return 503 so a misroute is loud rather than silently 200-ing unverified payloads.
import { isMarketplaceConfigured, loadMarketplaceEnv, type MarketplaceEnv } from '@/config/env';
import { verifyGithubSignature } from '@/lib/crypto/verifySignature';
import { checkBodySize } from '@/app/api/_lib/bodySizeGuard';

/**
 * Module-private — undefined when no marketplace secret is configured; never throws.
 * `loadMarketplaceEnv()` itself throws when unconfigured, so this file must never call it
 * unconditionally.
 */
function tryLoadMarketplaceEnv(): MarketplaceEnv | undefined {
  if (!isMarketplaceConfigured()) {
    return undefined;
  }
  return loadMarketplaceEnv();
}

/**
 * Testing seam mirroring the webhook receiver's `makePostHandler`. The optional
 * `marketplaceEnv` override keeps tests off process.env entirely.
 */
export function makePostHandler(overrides?: {
  marketplaceEnv?: MarketplaceEnv;
}): (req: Request) => Promise<Response> {
  return async function POST(req: Request): Promise<Response> {
    // 0. Body-size guard BEFORE reading the body (Content-Length only; see bodySizeGuard).
    const oversize = checkBodySize(req);
    if (oversize) return oversize;

    // 1. Unconfigured → 503 (loud misroute, never a silent unverified 200).
    const marketplaceEnv = overrides?.marketplaceEnv ?? tryLoadMarketplaceEnv();
    if (!marketplaceEnv) {
      return Response.json({ error: 'marketplace not configured' }, { status: 503 });
    }

    // 2. RAW body FIRST — before any parsing (Law 4).
    const raw = await req.text();

    // 3. Verify HMAC (constant-time; never re-serialize the payload) with the Marketplace
    //    secret. Bad/missing signature → 401.
    const signatureHeader = req.headers.get('x-hub-signature-256');
    const valid = verifyGithubSignature({
      payload: raw,
      signatureHeader,
      secret: marketplaceEnv.webhookSecret,
    });
    if (!valid) {
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }

    // 4. Verified — acknowledge. No downstream pipeline yet.
    return Response.json({ ok: true }, { status: 200 });
  };
}
