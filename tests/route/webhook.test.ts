import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Octokit } from 'octokit';
import { makePostHandler } from '@/app/api/webhook/github/handler';
import type { PipelineDeps } from '@/lib/pipeline/processPullRequest';
import type { PipelineInput, PullRequestWebhookPayload } from '@/types/github';
import type { Env, QueueEnv } from '@/config/env';
import { publishPipelineJob } from '@/lib/queue/qstash';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

function basePayload(overrides?: Partial<PullRequestWebhookPayload>): PullRequestWebhookPayload {
  return {
    action: 'opened',
    installation: { id: 987 },
    repository: {
      id: 42,
      name: 'backend-repo',
      owner: { login: 'acme' },
      full_name: 'acme/backend-repo',
    },
    pull_request: {
      number: 7,
      head: { sha: 'headsha123', ref: 'feature/x' },
      base: { ref: 'main' },
    },
    ...overrides,
  };
}

function makeRequest(opts: {
  body: string;
  event?: string | null;
  signature?: string | null;
  contentLength?: string | null;
}): Request {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  // Node's Request does not auto-populate Content-Length from a string body, and the
  // handler now requires it (T3 body-size guard). Default to the real byte length; a test
  // can override (or pass null to omit it) to exercise the guard.
  if (opts.contentLength !== null) {
    headers.set('content-length', opts.contentLength ?? String(Buffer.byteLength(opts.body)));
  }
  if (opts.event !== null) {
    headers.set('x-github-event', opts.event ?? 'pull_request');
  }
  if (opts.signature !== null) {
    headers.set('x-hub-signature-256', opts.signature ?? sign(opts.body, SECRET));
  }
  return new Request('http://localhost/api/webhook/github', {
    method: 'POST',
    headers,
    body: opts.body,
  });
}

function fakeQueueEnv(): QueueEnv {
  return {
    qstashToken: 'token',
    qstashCurrentSigningKey: 'current-key',
    qstashNextSigningKey: 'next-key',
  };
}

function fakeEnv(): Env {
  return {
    githubWebhookSecret: SECRET,
    githubAppId: 'app-id',
    githubAppPrivateKey: 'private-key',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key',
    scanConcurrency: 8,
    maxScanFiles: 2000,
    maxRefResolutionDepth: 5,
    maxFrontendLinksConcurrency: 3,
  };
}

function fakeDeps(): PipelineDeps {
  return {
    env: fakeEnv(),
    db: {} as SupabaseClient,
    getInstallationClient: async () => ({}) as Octokit,
  };
}

describe('POST /api/webhook/github', () => {
  it('1. valid signed pull_request.opened payload -> 202 queued:true, defers pipeline with exact PipelineInput', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const deps = fakeDeps();
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps,
      pipeline: pipelineSpy,
    });

    const payload = basePayload();
    const body = JSON.stringify(payload);
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: true });
    expect(tasks).toHaveLength(1);
    expect(pipelineSpy).not.toHaveBeenCalled();

    await tasks[0]!();

    const expectedInput: PipelineInput = {
      installationId: 987,
      backendRepoId: 42,
      backendOwner: 'acme',
      backendRepo: 'backend-repo',
      prNumber: 7,
      headSha: 'headsha123',
      headRef: 'feature/x',
      baseRef: 'main',
    };
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
    expect(pipelineSpy).toHaveBeenCalledWith(deps, expectedInput);
  });

  it('2. bad signature -> 401; pipeline spy NOT called; defer NOT called', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = JSON.stringify(basePayload());
    const req = makeRequest({ body, signature: sign(body, 'wrong-secret') });

    const res = await handler(req);

    expect(res.status).toBe(401);
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('3. missing signature header -> 401', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = JSON.stringify(basePayload());
    const req = makeRequest({ body, signature: null });

    const res = await handler(req);

    expect(res.status).toBe(401);
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('4. x-github-event: push -> 202 queued:false; no defer', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = JSON.stringify(basePayload());
    const req = makeRequest({ body, event: 'push' });

    const res = await handler(req);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: false, reason: 'ignored event' });
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('5. action closed -> 202 queued:false; no defer', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = JSON.stringify(basePayload({ action: 'closed' }));
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: false, reason: 'ignored action' });
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('6. missing installation -> 202 queued:false, reason: no installation', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const payload = basePayload();
    delete payload.installation;
    const body = JSON.stringify(payload);
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: false, reason: 'no installation' });
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('7. signed but malformed JSON body -> 400', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = '{ this is not valid json';
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'malformed JSON' });
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('8. response arrives before the deferred task runs (Law 5 ordering)', async () => {
    const tasks: Array<() => Promise<void>> = [];
    let pipelineResolved = false;
    const pipelineSpy = vi.fn(async () => {
      pipelineResolved = true;
    });
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = JSON.stringify(basePayload());
    const req = makeRequest({ body });

    const res = await handler(req);
    expect(res.status).toBe(202);

    // The pipeline must not have run yet — only the response has been produced.
    expect(pipelineSpy).not.toHaveBeenCalled();
    expect(pipelineResolved).toBe(false);
    expect(tasks).toHaveLength(1);

    // Only once the captured deferred task is manually awaited does the pipeline run.
    await tasks[0]!();
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
    expect(pipelineResolved).toBe(true);
  });

  // --- T3 (body-size cap) — reject on Content-Length before reading body / verifying ---

  it('T3a. oversized Content-Length -> 413; no verify, defer, or pipeline', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const publishSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
      queueEnv: fakeQueueEnv(),
      publish: publishSpy as unknown as typeof publishPipelineJob,
    });

    const body = JSON.stringify(basePayload());
    // Deliberately a valid signature so we prove the 413 fires BEFORE signature checks.
    const req = makeRequest({ body, contentLength: '999999999999' });

    const res = await handler(req);

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: 'payload too large' });
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('T3b. missing Content-Length -> 413', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = JSON.stringify(basePayload());
    const req = makeRequest({ body, contentLength: null });

    const res = await handler(req);

    expect(res.status).toBe(413);
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('T3c. malformed Content-Length (12x, -1) -> 413', async () => {
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({ deps: fakeDeps(), pipeline: pipelineSpy });

    const body = JSON.stringify(basePayload());

    const resAlpha = await handler(makeRequest({ body, contentLength: '12x' }));
    expect(resAlpha.status).toBe(413);

    const resNeg = await handler(makeRequest({ body, contentLength: '-1' }));
    expect(resNeg.status).toBe(413);

    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('T3d. normal signed request (correct Content-Length) still 202', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
    });

    const body = JSON.stringify(basePayload());
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(202);
    expect(tasks).toHaveLength(1);
  });

  // --- Track N (docs/specs/N-retry-queue.md) — new cases below, existing 8 unmodified ---

  it('9. no QSTASH_TOKEN configured -> behaves exactly as today (defer called, not publish)', async () => {
    // Force the real tryLoadQueueEnv()/isQueueConfigured() path to see an unconfigured
    // environment, regardless of what the host shell happens to have set, so this test
    // is deterministic (queueEnv override is deliberately omitted below).
    const QSTASH_VARS = ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'] as const;
    const originalValues = QSTASH_VARS.map((name) => process.env[name]);
    for (const name of QSTASH_VARS) delete process.env[name];

    try {
      const tasks: Array<() => Promise<void>> = [];
      const pipelineSpy = vi.fn(async () => {});
      const publishSpy = vi.fn(async () => {});
      const deps = fakeDeps();
      const handler = makePostHandler({
        defer: (t) => tasks.push(t),
        deps,
        pipeline: pipelineSpy,
        publish: publishSpy as unknown as typeof publishPipelineJob,
        // queueEnv deliberately omitted -> tryLoadQueueEnv() falls through to undefined,
        // exercising the real not-configured branch.
      });

      const payload = basePayload();
      const body = JSON.stringify(payload);
      const req = makeRequest({ body });

      const res = await handler(req);

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toEqual({ queued: true });
      expect(tasks).toHaveLength(1);
      expect(publishSpy).not.toHaveBeenCalled();
      expect(pipelineSpy).not.toHaveBeenCalled();

      await tasks[0]!();
      expect(pipelineSpy).toHaveBeenCalledTimes(1);
    } finally {
      QSTASH_VARS.forEach((name, i) => {
        const original = originalValues[i];
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      });
    }
  });

  it('10. QSTASH_TOKEN configured (queueEnv override) -> publish called with the built PipelineInput, defer NOT called, response is 202', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const publishSpy = vi.fn(async (_queueEnv: QueueEnv, _url: string, _input: PipelineInput) => {});
    const queueEnv = fakeQueueEnv();
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
      queueEnv,
      publish: publishSpy as unknown as typeof publishPipelineJob,
    });

    const payload = basePayload();
    const body = JSON.stringify(payload);
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: true });
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);

    const [calledQueueEnv, calledUrl, calledInput] = publishSpy.mock.calls[0]!;
    expect(calledQueueEnv).toBe(queueEnv);
    expect(calledUrl).toBe('http://localhost/api/webhook/process');
    expect(calledInput).toEqual<PipelineInput>({
      installationId: 987,
      backendRepoId: 42,
      backendOwner: 'acme',
      backendRepo: 'backend-repo',
      prNumber: 7,
      headSha: 'headsha123',
      headRef: 'feature/x',
      baseRef: 'main',
    });
  });

  it('11. publish override configured to reject -> response is 502; defer not called', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const pipelineSpy = vi.fn(async () => {});
    const publishSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    const handler = makePostHandler({
      defer: (t) => tasks.push(t),
      deps: fakeDeps(),
      pipeline: pipelineSpy,
      queueEnv: fakeQueueEnv(),
      publish: publishSpy as unknown as typeof publishPipelineJob,
    });

    const body = JSON.stringify(basePayload());
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(502);
    expect(tasks).toHaveLength(0);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  // Tests 12/13 (delivery-id claim dedup) were removed along with
  // processed_deliveries/claimDelivery — see webhook/github/handler.ts's header comment
  // for why: a claim committed before work is durably handed off has no safe release
  // path on either failure mode (publish failure, process death mid-after()), so it
  // silently swallows the very retries it existed to protect. Idempotency now lives
  // entirely in createInProgressCheckRun (tests/github/adapters.test.ts).
});
