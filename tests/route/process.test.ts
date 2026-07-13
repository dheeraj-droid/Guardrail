import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Octokit } from 'octokit';
import { makePostHandler } from '@/app/api/webhook/process/handler';
import type { PipelineDeps } from '@/lib/pipeline/processPullRequest';
import type { PipelineInput } from '@/types/github';
import type { QueueEnv, Env } from '@/config/env';

const CURRENT_KEY = 'current-signing-key';
const NEXT_KEY = 'next-signing-key';

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

/** Mirrors qstash.test.ts's real-algorithm token builder (spec: "do not stub the crypto"). */
function sign(bodyPayload: string, signingKey: string = CURRENT_KEY): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const bodyHash = createHash('sha256').update(bodyPayload).digest('base64url');
  const claims = {
    iss: 'Upstash',
    sub: 'https://example.com/api/webhook/process',
    exp: now + 300,
    nbf: now - 60,
    body: bodyHash,
  };
  const headerSegment = b64url(JSON.stringify(header));
  const payloadSegment = b64url(JSON.stringify(claims));
  const signatureSegment = createHmac('sha256', signingKey)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest('base64url');
  return `${headerSegment}.${payloadSegment}.${signatureSegment}`;
}

function fakeQueueEnv(): QueueEnv {
  return {
    qstashToken: 'token',
    qstashCurrentSigningKey: CURRENT_KEY,
    qstashNextSigningKey: NEXT_KEY,
  };
}

function fakeEnv(): Env {
  return {
    githubWebhookSecret: 'secret',
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

function samplePipelineInput(): PipelineInput {
  return {
    installationId: 987,
    backendRepoId: 42,
    backendOwner: 'acme',
    backendRepo: 'backend-repo',
    prNumber: 7,
    headSha: 'headsha123',
    headRef: 'feature/x',
    baseRef: 'main',
  };
}

function makeRequest(opts: { body: string; signature?: string | null }): Request {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  if (opts.signature !== null) {
    headers.set('upstash-signature', opts.signature ?? sign(opts.body));
  }
  return new Request('http://localhost/api/webhook/process', {
    method: 'POST',
    headers,
    body: opts.body,
  });
}

describe('POST /api/webhook/process', () => {
  it('1. valid signature, valid PipelineInput body -> pipeline spy called with the exact input; 200', async () => {
    const pipelineSpy = vi.fn(async () => {});
    const deps = fakeDeps();
    const handler = makePostHandler({ deps, pipeline: pipelineSpy, queueEnv: fakeQueueEnv() });

    const input = samplePipelineInput();
    const body = JSON.stringify(input);
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
    expect(pipelineSpy).toHaveBeenCalledWith(deps, input);
  });

  it('2. invalid signature -> 401; pipeline spy not called', async () => {
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      deps: fakeDeps(),
      pipeline: pipelineSpy,
      queueEnv: fakeQueueEnv(),
    });

    const body = JSON.stringify(samplePipelineInput());
    const req = makeRequest({ body, signature: 'not-a-valid-signature' });

    const res = await handler(req);

    expect(res.status).toBe(401);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('3. malformed JSON body -> 400', async () => {
    const pipelineSpy = vi.fn(async () => {});
    const handler = makePostHandler({
      deps: fakeDeps(),
      pipeline: pipelineSpy,
      queueEnv: fakeQueueEnv(),
    });

    const body = '{ this is not valid json';
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBe(400);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('4. pipeline spy configured to reject -> non-2xx response', async () => {
    const pipelineSpy = vi.fn(async () => {
      throw new Error('boom');
    });
    const handler = makePostHandler({
      deps: fakeDeps(),
      pipeline: pipelineSpy,
      queueEnv: fakeQueueEnv(),
    });

    const body = JSON.stringify(samplePipelineInput());
    const req = makeRequest({ body });

    const res = await handler(req);

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
  });
});
