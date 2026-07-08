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
import { after } from 'next/server';
import { loadEnv } from '@/config/env';
import { verifyGithubSignature } from '@/lib/crypto/verifySignature';
import { createDbClient } from '@/lib/db/supabase';
import { getInstallationClient } from '@/lib/github/client';
import {
  processPullRequest,
  type PipelineDeps,
} from '@/lib/pipeline/processPullRequest';
import type { PipelineInput, PullRequestWebhookPayload } from '@/types/github';

/**
 * Module-private helper — constructs the production PipelineDeps. Called INSIDE the
 * after() callback path only, never at module top level (imports must stay side-effect
 * free for tests and builds without env vars).
 */
function buildDeps(): PipelineDeps {
  const env = loadEnv();
  return { env, db: createDbClient(env), getInstallationClient };
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
}): (req: Request) => Promise<Response> {
  const defer = overrides?.defer ?? ((task: () => Promise<void>) => after(task));
  const pipeline = overrides?.pipeline ?? processPullRequest;

  return async function POST(req: Request): Promise<Response> {
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

    // 8. Defer the pipeline — never await before responding (Law 5). buildDeps() is
    //    called INSIDE the deferred callback, never at module top level or eagerly in
    //    the request path (keeps imports side-effect free for tests/builds).
    defer(() => pipeline(overrides?.deps ?? buildDeps(), input));

    // 9. Immediate 202 Accepted (SRD).
    return Response.json({ queued: true }, { status: 202 });
  };
}
