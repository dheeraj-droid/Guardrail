// Spec J, Part 1 — end-to-end integration test. Drives the REAL webhook route
// (makePostHandler, default `pipeline` = the real processPullRequest) with ONLY the
// network faked: a router-style fake Octokit (tests/helpers/fakeGithub.ts) standing in
// for the GitHub API, and a fake Supabase client standing in for project_links. Proves
// the SRD §4 verdict matrix end-to-end: webhook -> HMAC verify -> 202 -> deferred
// pipeline -> diff -> scan -> verdict -> check run + PR comment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePostHandler } from '@/app/api/webhook/github/handler';
import { COMMENT_MARKER } from '@/lib/github/comments';
import type { ProjectLink } from '@/types/db';
import type { PullRequestWebhookPayload } from '@/types/github';
import {
  buildOctokit,
  checkRunRoutes,
  contentsRoute,
  treeRoute,
  blobRoute,
  findCall,
  hasCall,
  httpError,
  makePipelineDeps,
  CONTENTS_ROUTE,
  TREE_ROUTE,
  BLOB_ROUTE,
  REPO_BY_ID_ROUTE,
  COMMENTS_LIST_ROUTE,
  COMMENTS_CREATE_ROUTE,
  CHECK_RUN_CONCLUDE_ROUTE,
} from '../helpers/fakeGithub';

// ---- fixtures --------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const openapiDir = join(here, '..', 'fixtures', 'openapi');
const frontendDir = join(here, '..', 'fixtures', 'frontend');
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');

// v1 -> v2: phoneNumber DELETED, age TYPE_MUTATED (integer -> string), plus
// nickname TYPE_MUTATED (request body) and address.street DELETED (not referenced by
// the frontend fixtures below, so they never produce a UsageMatch).
const V1_SPEC = read(openapiDir, 'user-v1.json');
const V2_SPEC = read(openapiDir, 'user-v2.json');

const PROFILE_TSX = read(frontendDir, 'profile.tsx');
const SETTINGS_TS = read(frontendDir, 'settings.ts');

// ---- webhook signing + payload construction (Track I pattern) --------------------------

function sign(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

function webhookPayload(fields: {
  repository: PullRequestWebhookPayload['repository'];
  pull_request: PullRequestWebhookPayload['pull_request'];
  action?: string;
  installation?: { id: number };
}): PullRequestWebhookPayload {
  return {
    action: fields.action ?? 'opened',
    installation: fields.installation ?? { id: 555 },
    repository: fields.repository,
    pull_request: fields.pull_request,
  };
}

function signedRequest(payload: PullRequestWebhookPayload, secret: string): Request {
  const body = JSON.stringify(payload);
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  // The handler's T3 body-size guard requires a Content-Length; Node's Request does not
  // auto-populate it from a string body, so set the real byte length here.
  headers.set('content-length', String(Buffer.byteLength(body)));
  headers.set('x-github-event', 'pull_request');
  headers.set('x-hub-signature-256', sign(body, secret));
  return new Request('http://localhost/api/webhook/github', { method: 'POST', headers, body });
}

// ---- comment-body inspection helpers (assert per-file, per-line without depending on
// table/section ordering) ----------------------------------------------------------------

/** Slice of `body` starting at the `**\`filePath\`**` header, up to (but excluding) the
 * next such header if one exists, else to the end of the string. */
function fileSection(body: string, filePath: string, nextFilePath?: string): string {
  const header = `**\`${filePath}\`**`;
  const start = body.indexOf(header);
  expect(start, `expected a "${header}" section in the comment body`).toBeGreaterThan(-1);
  if (nextFilePath === undefined) return body.slice(start);
  const nextHeader = `**\`${nextFilePath}\`**`;
  const end = body.indexOf(nextHeader);
  expect(end, `expected a "${nextHeader}" section after "${header}"`).toBeGreaterThan(start);
  return body.slice(start, end);
}

/** Distinct 1-based line numbers of bullet rows in `section` referencing `field`. */
function bulletLineNumbers(section: string, field: string): number[] {
  const re = new RegExp('^- Line (\\d+).*`' + field + '`', 'gm');
  return Array.from(section.matchAll(re)).map((m) => Number(m[1]));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Guardrail end-to-end (webhook -> pipeline -> verdict), only the network faked', () => {
  it('1. FAILURE row: breaking changes + frontend references -> 202 first, then failure conclusion + marked comment with per-file locations', async () => {
    const backendRepoId = 100;
    const frontendRepoId = 200;
    const headSha = 'head-sha-failure';
    const baseRef = 'main';
    const installationId = 4001;

    const link: ProjectLink = {
      id: 'link-failure',
      backend_repo_id: backendRepoId,
      frontend_repo_id: frontendRepoId,
      openapi_file_path: 'openapi.json',
      frontend_src_directory: 'src',
      created_at: '2026-01-01T00:00:00Z',
    };

    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(1001),
      [CONTENTS_ROUTE]: contentsRoute({ [baseRef]: V1_SPEC, [headSha]: V2_SPEC }),
      [REPO_BY_ID_ROUTE]: () => ({
        owner: { login: 'acme-frontend' },
        name: 'frontend-repo',
        default_branch: 'main',
      }),
      [TREE_ROUTE]: treeRoute([
        { path: 'src/profile.tsx', sha: 'sha-profile' },
        { path: 'src/settings.ts', sha: 'sha-settings' },
      ]),
      [BLOB_ROUTE]: blobRoute({ 'sha-profile': PROFILE_TSX, 'sha-settings': SETTINGS_TS }),
      [COMMENTS_LIST_ROUTE]: () => [],
      [COMMENTS_CREATE_ROUTE]: () => ({}),
    });

    const { deps, getInstallationClientMock } = makePipelineDeps({ link, octokit });
    const tasks: Array<() => Promise<void>> = [];
    const handler = makePostHandler({ defer: (t) => tasks.push(t), deps });

    const payload = webhookPayload({
      installation: { id: installationId },
      repository: {
        id: backendRepoId,
        name: 'backend-repo',
        owner: { login: 'acme' },
        full_name: 'acme/backend-repo',
      },
      pull_request: { number: 7, head: { sha: headSha, ref: 'feature/x' }, base: { ref: baseRef } },
    });
    const req = signedRequest(payload, deps.env.githubWebhookSecret);

    // --- 202 must arrive BEFORE the deferred pipeline does any work (Law 5). ---
    const res = await handler(req);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: true });
    expect(tasks).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();

    // --- Now run the deferred pipeline and assert on its effects. ---
    await tasks[0]!();

    expect(getInstallationClientMock).toHaveBeenCalledWith(deps.env, installationId);

    const concludeParams = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(concludeParams.conclusion).toBe('failure');

    const commentParams = findCall(request, COMMENTS_CREATE_ROUTE);
    const body: string = commentParams.body;
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);

    const profileSection = fileSection(body, 'src/profile.tsx', 'src/settings.ts');
    const phoneNumberLines = new Set(bulletLineNumbers(profileSection, 'phoneNumber'));
    expect(phoneNumberLines.size).toBe(2);
    expect(profileSection).toContain('(destructuring)');
    expect(profileSection).toContain('(property-access)');

    const settingsSection = fileSection(body, 'src/settings.ts');
    const ageLines = bulletLineNumbers(settingsSection, 'age');
    expect(ageLines.length).toBeGreaterThan(0);
  });

  it('2. SUCCESS + comment row: breaking changes, no frontend references -> success conclusion + "safe to merge" comment', async () => {
    const backendRepoId = 101;
    const frontendRepoId = 201;
    const headSha = 'head-sha-success-comment';
    const baseRef = 'main';

    const link: ProjectLink = {
      id: 'link-success-comment',
      backend_repo_id: backendRepoId,
      frontend_repo_id: frontendRepoId,
      openapi_file_path: 'openapi.json',
      frontend_src_directory: 'src',
      created_at: '2026-01-01T00:00:00Z',
    };

    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(1002),
      [CONTENTS_ROUTE]: contentsRoute({ [baseRef]: V1_SPEC, [headSha]: V2_SPEC }),
      [REPO_BY_ID_ROUTE]: () => ({
        owner: { login: 'acme-frontend' },
        name: 'frontend-repo',
        default_branch: 'main',
      }),
      [TREE_ROUTE]: treeRoute([{ path: 'src/unrelated.ts', sha: 'sha-unrelated' }]),
      [BLOB_ROUTE]: blobRoute({ 'sha-unrelated': 'export const unrelated = 1;\n' }),
      [COMMENTS_LIST_ROUTE]: () => [],
      [COMMENTS_CREATE_ROUTE]: () => ({}),
    });

    const { deps } = makePipelineDeps({ link, octokit });
    const tasks: Array<() => Promise<void>> = [];
    const handler = makePostHandler({ defer: (t) => tasks.push(t), deps });

    const payload = webhookPayload({
      repository: {
        id: backendRepoId,
        name: 'backend-repo',
        owner: { login: 'acme' },
        full_name: 'acme/backend-repo',
      },
      pull_request: { number: 8, head: { sha: headSha, ref: 'feature/y' }, base: { ref: baseRef } },
    });
    const req = signedRequest(payload, deps.env.githubWebhookSecret);

    const res = await handler(req);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: true });
    expect(request).not.toHaveBeenCalled();

    await tasks[0]!();

    const concludeParams = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(concludeParams.conclusion).toBe('success');

    const commentParams = findCall(request, COMMENTS_CREATE_ROUTE);
    const body: string = commentParams.body;
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('safe to merge');
  });

  it('3. SUCCESS clean row: identical old/new spec -> success; zero tree/blob/comment requests', async () => {
    const backendRepoId = 102;
    const frontendRepoId = 202;
    const headSha = 'head-sha-clean';
    const baseRef = 'main';

    const link: ProjectLink = {
      id: 'link-clean',
      backend_repo_id: backendRepoId,
      frontend_repo_id: frontendRepoId,
      openapi_file_path: 'openapi.json',
      frontend_src_directory: 'src',
      created_at: '2026-01-01T00:00:00Z',
    };

    // Deliberately NO tree/blob/comments/repositories-by-id routes registered: if the
    // pipeline regresses and calls any of them, buildOctokit's fake throws, which the
    // pipeline's catch turns into `neutral` — failing the `success` assertion below and
    // surfacing the regression loudly instead of silently.
    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(1003),
      [CONTENTS_ROUTE]: contentsRoute({ [baseRef]: V1_SPEC, [headSha]: V1_SPEC }),
    });

    const { deps } = makePipelineDeps({ link, octokit });
    const tasks: Array<() => Promise<void>> = [];
    const handler = makePostHandler({ defer: (t) => tasks.push(t), deps });

    const payload = webhookPayload({
      repository: {
        id: backendRepoId,
        name: 'backend-repo',
        owner: { login: 'acme' },
        full_name: 'acme/backend-repo',
      },
      pull_request: { number: 9, head: { sha: headSha, ref: 'feature/z' }, base: { ref: baseRef } },
    });
    const req = signedRequest(payload, deps.env.githubWebhookSecret);

    const res = await handler(req);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: true });

    await tasks[0]!();

    const concludeParams = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(concludeParams.conclusion).toBe('success');
    expect(concludeParams.output.title).toBe('No breaking schema changes found');

    expect(hasCall(request, TREE_ROUTE)).toBe(false);
    expect(hasCall(request, BLOB_ROUTE)).toBe(false);
    expect(hasCall(request, REPO_BY_ID_ROUTE)).toBe(false);
    expect(hasCall(request, COMMENTS_LIST_ROUTE)).toBe(false);
    expect(hasCall(request, COMMENTS_CREATE_ROUTE)).toBe(false);
  });

  it('4. Monorepo: equal backend/frontend ids -> scan hits the BACKEND repo at head sha under web/src, failure comment references web/src/profile.tsx', async () => {
    const repoId = 300; // backend_repo_id === frontend_repo_id (Law 8)
    const headSha = 'head-sha-monorepo';
    const baseRef = 'main';

    const link: ProjectLink = {
      id: 'link-monorepo',
      backend_repo_id: repoId,
      frontend_repo_id: repoId,
      openapi_file_path: 'openapi.json',
      frontend_src_directory: 'web/src',
      created_at: '2026-01-01T00:00:00Z',
    };

    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(1004),
      [CONTENTS_ROUTE]: contentsRoute({ [baseRef]: V1_SPEC, [headSha]: V2_SPEC }),
      [TREE_ROUTE]: treeRoute([
        { path: 'web/src/profile.tsx', sha: 'sha-profile-mono' },
        { path: 'web/src/settings.ts', sha: 'sha-settings-mono' },
      ]),
      [BLOB_ROUTE]: blobRoute({
        'sha-profile-mono': PROFILE_TSX,
        'sha-settings-mono': SETTINGS_TS,
      }),
      [COMMENTS_LIST_ROUTE]: () => [],
      [COMMENTS_CREATE_ROUTE]: () => ({}),
    });

    const { deps } = makePipelineDeps({ link, octokit });
    const tasks: Array<() => Promise<void>> = [];
    const handler = makePostHandler({ defer: (t) => tasks.push(t), deps });

    const payload = webhookPayload({
      repository: { id: repoId, name: 'mono-repo', owner: { login: 'acme' }, full_name: 'acme/mono-repo' },
      pull_request: { number: 10, head: { sha: headSha, ref: 'feature/mono' }, base: { ref: baseRef } },
    });
    const req = signedRequest(payload, deps.env.githubWebhookSecret);

    const res = await handler(req);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: true });

    await tasks[0]!();

    // Monorepo: never resolves the frontend repo via id — it IS the backend repo.
    expect(hasCall(request, REPO_BY_ID_ROUTE)).toBe(false);

    const treeParams = findCall(request, TREE_ROUTE);
    expect(treeParams).toMatchObject({ owner: 'acme', repo: 'mono-repo', tree_sha: headSha });

    const concludeParams = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(concludeParams.conclusion).toBe('failure');

    const commentParams = findCall(request, COMMENTS_CREATE_ROUTE);
    const body: string = commentParams.body;
    expect(body).toContain('web/src/profile.tsx');
  });

  it('5. Fail-open: tree endpoint 500s -> neutral "Guardrail internal error"; POST still returned 202', async () => {
    const backendRepoId = 103;
    const frontendRepoId = 203;
    const headSha = 'head-sha-failopen';
    const baseRef = 'main';

    const link: ProjectLink = {
      id: 'link-failopen',
      backend_repo_id: backendRepoId,
      frontend_repo_id: frontendRepoId,
      openapi_file_path: 'openapi.json',
      frontend_src_directory: 'src',
      created_at: '2026-01-01T00:00:00Z',
    };

    const { octokit, request } = buildOctokit({
      ...checkRunRoutes(1005),
      [CONTENTS_ROUTE]: contentsRoute({ [baseRef]: V1_SPEC, [headSha]: V2_SPEC }),
      [REPO_BY_ID_ROUTE]: () => ({
        owner: { login: 'acme-frontend' },
        name: 'frontend-repo',
        default_branch: 'main',
      }),
      [TREE_ROUTE]: () => {
        throw httpError(500);
      },
    });

    const { deps } = makePipelineDeps({ link, octokit });
    const tasks: Array<() => Promise<void>> = [];
    const handler = makePostHandler({ defer: (t) => tasks.push(t), deps });

    const payload = webhookPayload({
      repository: {
        id: backendRepoId,
        name: 'backend-repo',
        owner: { login: 'acme' },
        full_name: 'acme/backend-repo',
      },
      pull_request: { number: 11, head: { sha: headSha, ref: 'feature/failopen' }, base: { ref: baseRef } },
    });
    const req = signedRequest(payload, deps.env.githubWebhookSecret);

    // The POST handler must still ack 202 even though the deferred work will blow up.
    const res = await handler(req);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ queued: true });
    expect(request).not.toHaveBeenCalled();

    await expect(tasks[0]!()).resolves.toBeUndefined();

    const concludeParams = findCall(request, CHECK_RUN_CONCLUDE_ROUTE);
    expect(concludeParams.conclusion).toBe('neutral');
    expect(concludeParams.output.title).toBe('Guardrail internal error');
    expect(concludeParams.output.summary).toContain('HTTP 500');

    expect(hasCall(request, COMMENTS_CREATE_ROUTE)).toBe(false);
  });
});
