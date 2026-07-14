// Spec I — Gateway Webhook Receiver (SRD Module 1), handler factory.
//
// WHY this is split out of route.ts: a Next.js App Router `route.ts` may ONLY export the
// HTTP method handlers (GET/POST/…) and route-segment config (`runtime`, `dynamic`, …).
// `next build` generates a route-type check that FAILS on any other export. The testing
// seam `makePostHandler` is exactly such an extra export, so it lives here and route.ts
// imports it. Do NOT move makePostHandler back into route.ts (it breaks the production
// build even though `tsc --noEmit` passes).
//
// THIN shell: verify HMAC (Law 4), acknowledge 202 immediately, defer the pipeline
// (Law 5). Zero business logic — everything else is delegated to verifyGithubSignature
// (Track A) and processPullRequest (Track H).
//
// Track N (docs/PLAN_V2.md §3, docs/specs/N-retry-queue.md File 4) adds, opt-in /
// additive: when QSTASH_TOKEN is configured, publish to a durable queue instead of the
// after() fallback. A deployment that never sets QSTASH_TOKEN keeps today's after()
// behavior byte-for-byte.
//
// Idempotency lives ENTIRELY in createInProgressCheckRun (src/lib/github/checks.ts) —
// there is deliberately no delivery-id claim table here. An earlier draft added one
// (processed_deliveries) but it had a fatal flaw: claiming the delivery BEFORE the work
// is durably handed off means a claim survives even when the work doesn't -- a publish
// failure (which returns 502 specifically so GitHub retries) or a process death mid-
// after() both leave a committed claim with no completed work behind it, so the retry
// GitHub sends to recover is silently swallowed by that same claim. There is no safe
// point to release it: the queue path could release on a caught publish failure, but
// the after() path can't release anything after the process has already died.
// createInProgressCheckRun's idempotency has no such failure mode -- an attempt that
// created nothing lets a retry proceed and create fresh; one that created an in-flight
// run gets it reused -- so it is the sole, delivery-mechanism-agnostic mechanism.
import { after } from 'next/server';
import { loadEnv, isQueueConfigured, loadQueueEnv, readAppBaseUrl, type QueueEnv } from '@/config/env';
import { verifyGithubSignature } from '@/lib/crypto/verifySignature';
import { publishPipelineJob } from '@/lib/queue/qstash';
import {
  processPullRequest,
  type PipelineDeps,
} from '@/lib/pipeline/processPullRequest';
import { buildDeps } from '@/app/api/webhook/_lib/buildDeps';
import type { PipelineInput, PullRequestWebhookPayload } from '@/types/github';

// Early-rejection guard, NOT a metered stream cap: both GitHub and QStash always send a
// Content-Length header, so we can reject an oversized (or header-less / malformed) body
// before reading it. This does not defend against a chunked/streamed body with no length
// header — it is a cheap first gate on the documented senders. 25 MiB is GitHub's payload
// ceiling.
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
 * Module-private — undefined when no queue is configured; never throws (Track N).
 * `loadQueueEnv()` itself throws when unconfigured, so this file must never call it
 * unconditionally.
 */
function tryLoadQueueEnv(): QueueEnv | undefined {
  if (!isQueueConfigured()) {
    return undefined;
  }
  return loadQueueEnv();
}

/**
 * Testing seam (spec "Testing seam" section). `after()` from next/server cannot run in
 * vitest, so the handler takes optional injection points. Prod wiring (route.ts) uses
 * every default.
 */
export function makePostHandler(overrides?: {
  defer?: (task: () => Promise<void>) => void;
  deps?: PipelineDeps;
  pipeline?: typeof processPullRequest;
  queueEnv?: QueueEnv;
  publish?: typeof publishPipelineJob;
  baseUrl?: string;
}): (req: Request) => Promise<Response> {
  const defer = overrides?.defer ?? ((task: () => Promise<void>) => after(task));
  const pipeline = overrides?.pipeline ?? processPullRequest;
  const publish = overrides?.publish ?? publishPipelineJob;

  return async function POST(req: Request): Promise<Response> {
    // 0. Body-size guard BEFORE reading the body (Content-Length only; see MAX_BODY_BYTES).
    const oversize = checkBodySize(req);
    if (oversize) return oversize;

    // 1. RAW body FIRST — before any parsing (Law 4).
    const raw = await req.text();

    // 2. Verify HMAC (constant-time; never re-serialize the payload). Use the injected
    //    deps' env when present so tests never touch process.env via loadEnv() — the
    //    testing seam must short-circuit env access entirely on every code path, not
    //    just the deferred pipeline call.
    const signatureHeader = req.headers.get('x-hub-signature-256');
    const env = overrides?.deps?.env ?? loadEnv();
    const valid = verifyGithubSignature({
      payload: raw,
      signatureHeader,
      secret: env.githubWebhookSecret,
    });
    if (!valid) {
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }

    // 3. Only pull_request events are relevant.
    const event = req.headers.get('x-github-event');
    if (event !== 'pull_request') {
      return Response.json({ queued: false, reason: 'ignored event' }, { status: 202 });
    }

    // 4. Parse JSON. Signature already passed, so a parse failure is a misconfigured
    //    sender, not an attacker.
    let payload: PullRequestWebhookPayload;
    try {
      payload = JSON.parse(raw) as PullRequestWebhookPayload;
    } catch {
      return Response.json({ error: 'malformed JSON' }, { status: 400 });
    }

    // 5. SRD trigger events only.
    if (payload.action !== 'opened' && payload.action !== 'synchronize') {
      return Response.json({ queued: false, reason: 'ignored action' }, { status: 202 });
    }

    // 6. Installation id is required for App auth (Law 3). Never 5xx a webhook — GitHub
    //    disables noisy hooks.
    const installationId = payload.installation?.id;
    if (installationId === undefined) {
      console.warn('[guardrail] webhook missing installation id — App misconfigured?');
      return Response.json(
        { queued: false, reason: 'no installation' },
        { status: 202 },
      );
    }

    // 7. Build PipelineInput (SRD Module 1 extraction).
    const input: PipelineInput = {
      installationId,
      backendRepoId: payload.repository.id,
      backendOwner: payload.repository.owner.login,
      backendRepo: payload.repository.name,
      prNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
    };

    // 8. Branch on queue configuration (Track N). Queue path: await only the fast
    //    publish call (never the pipeline itself — Law 5 still applies), ack 202 only
    //    after publish succeeds so a publish failure surfaces as a 5xx GitHub will
    //    retry, rather than acking into a job that never got enqueued.
    const queueEnv = overrides?.queueEnv ?? tryLoadQueueEnv();
    if (queueEnv) {
      try {
        // Pin the publish target to APP_BASE_URL when set (never the spoofable request
        // Host); fall back to req.url otherwise. The override seam keeps tests off
        // process.env, mirroring the queueEnv override.
        const base = overrides?.baseUrl ?? readAppBaseUrl() ?? req.url;
        await publish(queueEnv, new URL('/api/webhook/process', base).toString(), input);
      } catch (error) {
        console.error(
          '[guardrail] queue publish failed:',
          error instanceof Error ? error.message : String(error),
        );
        return Response.json({ error: 'failed to enqueue' }, { status: 502 });
      }
      return Response.json({ queued: true }, { status: 202 });
    }

    // Fallback: no queue configured — today's v1 behavior, byte-for-byte. Never await
    // before responding (Law 5). deps resolved lazily inside the deferred callback,
    // exactly as pre-Track-N, since there is no longer an earlier awaited step (the
    // delivery claim) that required resolving it eagerly.
    defer(() => pipeline(overrides?.deps ?? buildDeps(), input));

    // 9. Immediate 202 Accepted (SRD).
    return Response.json({ queued: true }, { status: 202 });
  };
}
