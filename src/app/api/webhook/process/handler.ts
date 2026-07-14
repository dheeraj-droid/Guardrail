// Track N — Durable Retry Queue (docs/PLAN_V2.md §3, docs/specs/N-retry-queue.md File 3),
// process route handler factory.
//
// WHY this is split out of route.ts: identical reasoning to webhook/github/handler.ts —
// a Next.js App Router `route.ts` may ONLY export the HTTP method handlers and
// route-segment config; `next build` generates a route-type check that FAILS on any
// other export. The testing seam `makePostHandler` is exactly such an extra export, so
// it lives here and route.ts imports it. Do NOT move makePostHandler back into route.ts.
//
// This is the QStash delivery target: verify the QStash signature (a SEPARATE trust
// boundary from GitHub's — never reuses GITHUB_WEBHOOK_SECRET), parse PipelineInput, and
// AWAIT processPullRequest directly — no after() here. QStash's own invocation already
// grants this request its own timeout/retry budget; deferring further would just
// reintroduce the exact risk Track N exists to close.
//
// This route's ONLY protection against a QStash redelivery landing here more than once
// for the same commit is createInProgressCheckRun's idempotency (checks.ts), reached
// inside pipeline(deps, input) itself — there is no delivery-id claim anywhere in this
// build (see webhook/github/handler.ts's header comment for why an earlier draft's
// claim table was removed: a claim committed before work is durably handed off has no
// safe release path on either failure mode, so it silently swallows the very retries
// it was meant to protect).
import { loadEnv, loadQueueEnv, type QueueEnv } from '@/config/env';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { createDbClient } from '@/lib/db/supabase';
import { getInstallationClient } from '@/lib/github/client';
import {
  processPullRequest,
  type PipelineDeps,
} from '@/lib/pipeline/processPullRequest';
import type { PipelineInput } from '@/types/github';

// Early-rejection guard, NOT a metered stream cap: both GitHub and QStash always send a
// Content-Length header, so we can reject an oversized (or header-less / malformed) body
// before reading it. 25 MiB matches the GitHub route's cap.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Reject when Content-Length is absent, not a strict non-negative decimal, or exceeds
 * MAX_BODY_BYTES. Returns a 413 Response to send back, or null to proceed.
 */
function checkBodySize(req: Request): Response | null {
  const header = req.headers.get('content-length');
  if (header === null || !/^\d+$/.test(header) || Number(header) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload too large' }, { status: 413 });
  }
  return null;
}

/**
 * Module-private helper — constructs the production PipelineDeps. Called INSIDE the
 * request path (this route awaits the pipeline directly), never at module top level
 * (imports must stay side-effect free for tests and builds without env vars).
 */
function buildDeps(): PipelineDeps {
  const env = loadEnv();
  return { env, db: createDbClient(env), getInstallationClient };
}

/**
 * Testing seam. Prod wiring (route.ts) uses every default.
 */
export function makePostHandler(overrides?: {
  deps?: PipelineDeps;
  pipeline?: typeof processPullRequest;
  queueEnv?: QueueEnv;
}): (req: Request) => Promise<Response> {
  const pipeline = overrides?.pipeline ?? processPullRequest;

  return async function POST(req: Request): Promise<Response> {
    // 0. Body-size guard BEFORE reading the body (Content-Length only; see MAX_BODY_BYTES).
    const oversize = checkBodySize(req);
    if (oversize) return oversize;

    // 1. RAW body FIRST — same discipline as the GitHub route even though this is an
    //    internal hop; the signature covers the raw bytes.
    const raw = await req.text();

    // 2. Verify the QStash signature — a separate trust boundary from GitHub's.
    const queueEnv = overrides?.queueEnv ?? loadQueueEnv();
    const valid = verifyQStashSignature({
      payload: raw,
      signatureHeader: req.headers.get('upstash-signature'),
      currentSigningKey: queueEnv.qstashCurrentSigningKey,
      nextSigningKey: queueEnv.qstashNextSigningKey,
    });
    if (!valid) {
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }

    // 3. Parse PipelineInput — malformed is a QStash-side bug, not worth retrying.
    let input: PipelineInput;
    try {
      input = JSON.parse(raw) as PipelineInput;
    } catch {
      return Response.json({ error: 'malformed JSON' }, { status: 400 });
    }

    // 4. AWAIT the pipeline directly — no after() here (see file header).
    try {
      await pipeline(overrides?.deps ?? buildDeps(), input);
    } catch (error) {
      // Contract violation (processPullRequest never rejects — Law 10), but defend the
      // HTTP layer regardless so QStash retries delivery.
      console.error(
        '[guardrail] process route: pipeline rejected unexpectedly:',
        error instanceof Error ? error.message : String(error),
      );
      return Response.json({ error: 'processing failed' }, { status: 500 });
    }

    // 5. 200 even if processPullRequest internally concluded `neutral` — "it returned"
    //    IS the success signal; QStash should not retry a run that completed.
    return Response.json({ processed: true }, { status: 200 });
  };
}
