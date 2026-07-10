import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Octokit } from 'octokit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';
import type { PipelineInput } from '@/types/github';
import type { ProjectLink } from '@/types/db';
import { processPullRequest, type PipelineDeps } from '@/lib/pipeline/processPullRequest';
import { COMMENT_MARKER } from '@/lib/github/comments';

// ---- fixtures -------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures', 'openapi');
const readFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf8');

const V1_SPEC = readFixture('user-v1.json');
const V2_SPEC = readFixture('user-v2.json');

const BACKEND_REPO_ID = 100;

const INPUT: PipelineInput = {
  installationId: 7,
  backendRepoId: BACKEND_REPO_ID,
  backendOwner: 'acme',
  backendRepo: 'backend-repo',
  prNumber: 42,
  headSha: 'head-sha-123',
  headRef: 'feature/x',
  baseRef: 'main',
};

function makeLink(overrides: Partial<ProjectLink> = {}): ProjectLink {
  return {
    id: 'link-1',
    backend_repo_id: BACKEND_REPO_ID,
    frontend_repo_id: BACKEND_REPO_ID, // monorepo by default
    openapi_file_path: 'openapi.json',
    frontend_src_directory: 'src',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---- fake db (Track D test shape: chainable from().select().eq().maybeSingle()) --

function makeDb(row: ProjectLink | null): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  const db = { from: () => builder };
  return db as unknown as SupabaseClient;
}

// ---- stub env ---------------------------------------------------------------------

function makeEnv(): Env {
  return {
    githubWebhookSecret: 'stub-secret',
    githubAppId: '123456',
    githubAppPrivateKey: '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n',
    supabaseUrl: 'https://stub.supabase.co',
    supabaseServiceRoleKey: 'stub-service-role-key',
    scanConcurrency: 8,
    maxScanFiles: 2000,
    maxRefResolutionDepth: 5,
    maxFrontendLinksConcurrency: 3,
  };
}

// ---- fake octokit: { request: vi.fn() } routing by URL string ---------------------

const CONTENTS_ROUTE = 'GET /repos/{owner}/{repo}/contents/{path}';
const TREE_ROUTE = 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}';
const BLOB_ROUTE = 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}';
const CHECK_RUN_CREATE_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';
const CHECK_RUN_CONCLUDE_ROUTE = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';
const REPO_BY_ID_ROUTE = 'GET /repositories/{id}';
const COMMENTS_LIST_ROUTE = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments';
const COMMENTS_CREATE_ROUTE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments';

type RouteHandler = (params: Record<string, unknown>) => unknown;

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Builds a fake octokit whose `request` dispatches by route string to `routes`. */
function buildOctokit(routes: Record<string, RouteHandler>): {
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

function checkRunRoutes(checkRunId: number): Record<string, RouteHandler> {
  return {
    [CHECK_RUN_CREATE_ROUTE]: () => ({ id: checkRunId }),
    [CHECK_RUN_CONCLUDE_ROUTE]: () => ({}),
  };
}

/** Contents route keyed by `ref`; a ref absent from `byRef` maps to a 404. */
function contentsRoute(byRef: Record<string, string>): RouteHandler {
  return (params) => {
    const text = byRef[params.ref as string];
    if (text === undefined) throw httpError(404);
    return { content: b64(text), encoding: 'base64' };
  };
}

function treeRoute(files: ReadonlyArray<{ path: string; sha: string }>, truncated = false): RouteHandler {
  return () => ({ truncated, tree: files.map((f) => ({ ...f, type: 'blob' })) });
}

function blobRoute(contents: Record<string, string>): RouteHandler {
  return (params) => ({
    content: b64(contents[params.file_sha as string] ?? ''),
    encoding: 'base64',
  });
}

// ---- deps builder -------------------------------------------------------------------

function makeDeps(opts: { link: ProjectLink | null; octokit: Octokit }): {
  deps: PipelineDeps;
  getInstallationClientMock: ReturnType<typeof vi.fn>;
} {
  const getInstallationClientMock = vi.fn(async (_env: Env, _installationId: number) => opts.octokit);
  const deps: PipelineDeps = {
    env: makeEnv(),
    db: makeDb(opts.link),
    getInstallationClient: getInstallationClientMock,
  };
  return { deps, getInstallationClientMock };
}

/** Find a call to `route`, asserting it happened, and return its params as `any`
 * (the real Octokit response/params shapes are asserted structurally via toMatchObject
 * elsewhere; casting here only reduces test-file noise when reaching into nested
 * `output.title` / `output.summary` fields). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findCall(request: ReturnType<typeof vi.fn>, route: string): any {
  const call = request.mock.calls.find(([r]) => r === route);
  expect(call, `expected a call to ${route}`).toBeDefined();
  return call![1];
}

function hasCall(request: ReturnType<typeof vi.fn>, route: string): boolean {
  return request.mock.calls.some(([r]) => r === route);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processPullRequest', () => {
  it('1. unregistered repo -> returns; zero octokit calls', async () => {
    const { octokit, request } = buildOctokit({});
    const { deps, getInstallationClientMock } = makeDeps({ link: null, octokit });

    await processPullRequest(deps, INPUT);

    expect(getInstallationClientMock).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('2. no schema changes (v1 vs v1) -> concludes success; no tree/blob calls; no comment', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(11),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC, [INPUT.headSha]: V1_SPEC }),
    });
    const { deps, getInstallationClientMock } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    expect(getInstallationClientMock).toHaveBeenCalledWith(deps.env, INPUT.installationId);

    const params = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(params.conclusion).toBe('success');
    expect(params.output.title).toBe('No breaking schema changes found');

    expect(hasCall(request, TREE_ROUTE)).toBe(false);
    expect(hasCall(request, BLOB_ROUTE)).toBe(false);
    expect(hasCall(request, COMMENTS_LIST_ROUTE)).toBe(false);
    expect(hasCall(request, COMMENTS_CREATE_ROUTE)).toBe(false);
  });

  it('3. breaking changes + frontend references -> conclude failure; comment has marker + location; summary is truncate-safe', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(21),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC, [INPUT.headSha]: V2_SPEC }),
      [TREE_ROUTE]: treeRoute([{ path: 'src/a.ts', sha: 'sha-a' }]),
      [BLOB_ROUTE]: blobRoute({ 'sha-a': 'export function Profile(u) {\n  return u.phoneNumber;\n}\n' }),
      [COMMENTS_LIST_ROUTE]: () => [],
      [COMMENTS_CREATE_ROUTE]: () => ({}),
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const concludeParams = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(concludeParams.conclusion).toBe('failure');
    expect(concludeParams.output.summary.length).toBeLessThanOrEqual(65535);

    const commentParams = findCall(request, COMMENTS_CREATE_ROUTE);
    expect(commentParams.body).toContain(COMMENT_MARKER);
    expect(commentParams.body).toContain('src/a.ts');
    expect(commentParams.body).toContain('phoneNumber');
    expect(commentParams.body).toContain('Line 2');
  });

  it('4. breaking changes, no frontend references -> conclude success; comment posted (safe to merge)', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(22),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC, [INPUT.headSha]: V2_SPEC }),
      [TREE_ROUTE]: treeRoute([{ path: 'src/a.ts', sha: 'sha-a' }]),
      [BLOB_ROUTE]: blobRoute({ 'sha-a': 'export const unrelated = 1;\n' }),
      [COMMENTS_LIST_ROUTE]: () => [],
      [COMMENTS_CREATE_ROUTE]: () => ({}),
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const concludeParams = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(concludeParams.conclusion).toBe('success');

    const commentParams = findCall(request, COMMENTS_CREATE_ROUTE);
    expect(commentParams.body).toContain(COMMENT_MARKER);
    expect(commentParams.body).toContain('safe to merge');
  });

  it('5. spec missing on both refs -> conclude neutral (spec not found)', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(31),
      [CONTENTS_ROUTE]: () => {
        throw httpError(404);
      },
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const params = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(params.conclusion).toBe('neutral');
    expect(params.output.title).toBe('OpenAPI spec not found');
    expect(params.output.summary).toContain(link.openapi_file_path);

    expect(hasCall(request, TREE_ROUTE)).toBe(false);
  });

  it('6. new spec added (old missing, new exists) -> conclude success', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(32),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.headSha]: V1_SPEC }),
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const params = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(params.conclusion).toBe('success');
    expect(params.output.title).toBe('New OpenAPI spec added');
  });

  it('7. unparseable new spec -> conclude neutral', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(33),
      [CONTENTS_ROUTE]: contentsRoute({
        [INPUT.baseRef]: V1_SPEC,
        [INPUT.headSha]: '{ not valid json',
      }),
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const params = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(params.conclusion).toBe('neutral');
    expect(params.output.title).toBe('OpenAPI spec unparseable');
  });

  it('8. monorepo (ids equal) -> scan hits the backend repo at input.headSha; never calls GET /repositories/{id}', async () => {
    const link = makeLink({ frontend_repo_id: BACKEND_REPO_ID });
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(41),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC, [INPUT.headSha]: V2_SPEC }),
      [TREE_ROUTE]: treeRoute([]),
      [COMMENTS_LIST_ROUTE]: () => [],
      [COMMENTS_CREATE_ROUTE]: () => ({}),
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const treeParams = findCall(request, TREE_ROUTE);
    expect(treeParams).toMatchObject({
      owner: INPUT.backendOwner,
      repo: INPUT.backendRepo,
      tree_sha: INPUT.headSha,
    });

    expect(hasCall(request, REPO_BY_ID_ROUTE)).toBe(false);
  });

  it('9. cross-repo -> GET /repositories/{id} resolved; tree call uses default_branch', async () => {
    const link = makeLink({ frontend_repo_id: 999 });
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(42),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC, [INPUT.headSha]: V2_SPEC }),
      [REPO_BY_ID_ROUTE]: () => ({
        owner: { login: 'frontend-owner' },
        name: 'frontend-repo',
        default_branch: 'develop',
      }),
      [TREE_ROUTE]: treeRoute([]),
      [COMMENTS_LIST_ROUTE]: () => [],
      [COMMENTS_CREATE_ROUTE]: () => ({}),
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const repoParams = findCall(request, REPO_BY_ID_ROUTE);
    expect(repoParams).toMatchObject({ id: 999 });

    const treeParams = findCall(request, TREE_ROUTE);
    expect(treeParams).toMatchObject({
      owner: 'frontend-owner',
      repo: 'frontend-repo',
      tree_sha: 'develop',
    });
  });

  it('10. scanFrontendRepo throwing (tree call rejects) -> conclude neutral, Guardrail internal error; never rejects', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(51),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC, [INPUT.headSha]: V2_SPEC }),
      [TREE_ROUTE]: () => {
        throw new Error('tree fetch exploded');
      },
    });
    const { deps } = makeDeps({ link, octokit });

    await expect(processPullRequest(deps, INPUT)).resolves.toBeUndefined();

    const params = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(params.conclusion).toBe('neutral');
    expect(params.output.title).toBe('Guardrail internal error');
    expect(params.output.summary).toContain('tree fetch exploded');
  });

  it('11. comment upsert failing -> still concludes the check run (neutral); no unhandled rejection', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(52),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC, [INPUT.headSha]: V2_SPEC }),
      [TREE_ROUTE]: treeRoute([{ path: 'src/a.ts', sha: 'sha-a' }]),
      [BLOB_ROUTE]: blobRoute({ 'sha-a': 'user.phoneNumber;\n' }),
      [COMMENTS_LIST_ROUTE]: () => {
        throw new Error('comments list failed');
      },
    });
    const { deps } = makeDeps({ link, octokit });

    await expect(processPullRequest(deps, INPUT)).resolves.toBeUndefined();

    const params = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(params.conclusion).toBe('neutral');
    expect(params.output.title).toBe('Guardrail internal error');
  });

  // Bonus coverage (not in the spec's enumerated acceptance list, but present in the
  // control-flow's step 4 third bullet): spec removed on the head ref.
  it('12. (bonus) spec removed on head ref -> conclude neutral, "OpenAPI spec was removed"', async () => {
    const link = makeLink();
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(61),
      [CONTENTS_ROUTE]: contentsRoute({ [INPUT.baseRef]: V1_SPEC }),
    });
    const { deps } = makeDeps({ link, octokit });

    await processPullRequest(deps, INPUT);

    const params = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(params.conclusion).toBe('neutral');
    expect(params.output.title).toBe('OpenAPI spec was removed');
  });
});
