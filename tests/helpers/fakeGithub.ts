// Track J (Spec J, Part 1) ONLY — shared fake-octokit/db/env test doubles, extracted
// from Track H's (tests/pipeline/processPullRequest.test.ts) and Track I's
// (tests/route/webhook.test.ts) inline patterns. Spec J explicitly allows this
// extraction for the integration test; no production code imports this file, and no
// other track's test file has been modified to use it.
import { expect, vi } from 'vitest';
import type { Octokit } from 'octokit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';
import type { ProjectLink } from '@/types/db';
import type { PipelineDeps } from '@/lib/pipeline/processPullRequest';

// ---- Octokit route constants (string keys Octokit.request dispatches on) -------------

export const CONTENTS_ROUTE = 'GET /repos/{owner}/{repo}/contents/{path}';
export const TREE_ROUTE = 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}';
export const BLOB_ROUTE = 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}';
export const CHECK_RUN_LOOKUP_ROUTE = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
export const CHECK_RUN_CREATE_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';
export const CHECK_RUN_CONCLUDE_ROUTE = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';
export const REPO_BY_ID_ROUTE = 'GET /repositories/{id}';
export const COMMENTS_LIST_ROUTE = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments';
export const COMMENTS_CREATE_ROUTE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments';

export type RouteHandler = (params: Record<string, unknown>) => unknown;

/** Base64-encode a UTF-8 string the way the GitHub API would. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** An Error shaped like an Octokit HTTP error (has a numeric `.status`). */
export function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Builds a fake octokit whose `request` dispatches by route string to `routes`. */
export function buildOctokit(routes: Record<string, RouteHandler>): {
  octokit: Octokit;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    const handler = routes[route];
    if (!handler) {
      throw new Error(`unhandled test route: ${route} ${JSON.stringify(params)}`);
    }
    return { data: handler(params) };
  });
  const octokit = { request } as unknown as Octokit;
  return { octokit, request };
}

export function checkRunRoutes(checkRunId: number): Record<string, RouteHandler> {
  return {
    // Track N idempotency lookup (src/lib/github/checks.ts) — no existing runs, so
    // createInProgressCheckRun always falls through to the POST below.
    [CHECK_RUN_LOOKUP_ROUTE]: () => ({ check_runs: [] }),
    [CHECK_RUN_CREATE_ROUTE]: () => ({ id: checkRunId }),
    [CHECK_RUN_CONCLUDE_ROUTE]: () => ({}),
  };
}

/** Contents route keyed by `ref`; a ref absent from `byRef` maps to a 404. */
export function contentsRoute(byRef: Record<string, string>): RouteHandler {
  return (params) => {
    const text = byRef[params.ref as string];
    if (text === undefined) throw httpError(404);
    return { content: b64(text), encoding: 'base64' };
  };
}

export function treeRoute(
  files: ReadonlyArray<{ path: string; sha: string }>,
  truncated = false,
): RouteHandler {
  return () => ({ truncated, tree: files.map((f) => ({ ...f, type: 'blob' })) });
}

export function blobRoute(contents: Record<string, string>): RouteHandler {
  return (params) => ({
    content: b64(contents[params.file_sha as string] ?? ''),
    encoding: 'base64',
  });
}

/** Find a call to `route`, asserting it happened, and return its params as `any`
 * (mirrors tests/pipeline/processPullRequest.test.ts — casting here only reduces
 * test-file noise when reaching into nested `output.title` / `output.summary`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findCall(request: ReturnType<typeof vi.fn>, route: string): any {
  const call = request.mock.calls.find(([r]) => r === route);
  expect(call, `expected a call to ${route}`).toBeDefined();
  return call![1];
}

export function hasCall(request: ReturnType<typeof vi.fn>, route: string): boolean {
  return request.mock.calls.some(([r]) => r === route);
}

// ---- fake db (Track D test shape: chainable from().select().eq()) ----------------------
//
// Spec P (Wave V2, docs/PLAN_V2.md §4-§5): processPullRequest.ts now calls the PLURAL
// getProjectLinksByBackendRepoId, which does `.eq(...)` and awaits the query builder
// directly (no `.maybeSingle()`). Supabase's real query builders are PromiseLike
// (thenable) objects, so this fake mirrors that shape via a `then` method rather than
// returning a plain (non-thenable) object from `.eq()`. `makeDb`'s own exported
// signature is unchanged (`row: ProjectLink | null`) — this is a pure internal fix so
// tests/integration/pipeline.e2e.test.ts (the only consumer of this helper) keeps
// passing against the new plural lookup; no other track's test file uses this helper.

export function makeDb(row: ProjectLink | null): SupabaseClient {
  const rows = row ? [row] : [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    then: (
      resolve: (value: { data: ProjectLink[]; error: null }) => void,
    ) => resolve({ data: rows, error: null }),
    // Kept for completeness — no longer exercised by processPullRequest.ts, which now
    // uses the plural lookup exclusively, but harmless to leave in place.
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  const db = { from: () => builder };
  return db as unknown as SupabaseClient;
}

// ---- fake env -------------------------------------------------------------------------

export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    githubWebhookSecret: 'e2e-webhook-secret',
    githubAppId: 'app-id',
    githubAppPrivateKey: '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key',
    scanConcurrency: 8,
    maxScanFiles: 2000,
    maxRefResolutionDepth: 5,
    maxFrontendLinksConcurrency: 3,
    ...overrides,
  };
}

// ---- PipelineDeps builder ---------------------------------------------------------------

/** Assembles a full fake PipelineDeps (env + db + installation-client factory) for driving
 * processPullRequest (directly, or indirectly through makePostHandler) against a fake
 * octokit. `getInstallationClient` always resolves to the SAME `octokit`, matching the
 * real system's single App-installation client (CLAUDE.md Law 3). */
export function makePipelineDeps(opts: {
  link: ProjectLink | null;
  octokit: Octokit;
  env?: Partial<Env>;
}): { deps: PipelineDeps; getInstallationClientMock: ReturnType<typeof vi.fn> } {
  const getInstallationClientMock = vi.fn(async (_env: Env, _installationId: number) => opts.octokit);
  const deps: PipelineDeps = {
    env: fakeEnv(opts.env),
    db: makeDb(opts.link),
    getInstallationClient: getInstallationClientMock,
  };
  return { deps, getInstallationClientMock };
}
