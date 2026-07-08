import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Octokit } from 'octokit';
import { makePostHandler } from '@/app/api/webhook/github/route';
import type { PipelineDeps } from '@/lib/pipeline/processPullRequest';
import type { PipelineInput, PullRequestWebhookPayload } from '@/types/github';
import type { Env } from '@/config/env';

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
}): Request {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
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

function fakeEnv(): Env {
  return {
    githubWebhookSecret: SECRET,
    githubAppId: 'app-id',
    githubAppPrivateKey: 'private-key',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key',
    scanConcurrency: 8,
    maxScanFiles: 2000,
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
});
