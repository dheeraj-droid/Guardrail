import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as RequireSessionModule from '@/app/api/_lib/requireSession';
import type * as UserReposModule from '@/lib/github/userRepos';

// Hoisted so the vi.mock() factories below (themselves hoisted above these imports by
// vitest) can reference them. Only the pieces that would otherwise do real network/db
// work are mocked; requireSession/requireCsrf and authorizeLink/toRepoAccess run for
// REAL, so the route's own wiring (cookies, csrf header, authorization law) is genuinely
// exercised end to end.
const mocks = vi.hoisted(() => ({
  buildDashboardDeps: vi.fn(),
  listAccessibleRepos: vi.fn(),
  listLinksForRepoIds: vi.fn(),
  upsertProjectLink: vi.fn(),
  deleteProjectLink: vi.fn(),
}));

vi.mock('@/app/api/_lib/requireSession', async (importOriginal) => {
  const actual = await importOriginal<typeof RequireSessionModule>();
  return { ...actual, buildDashboardDeps: mocks.buildDashboardDeps };
});

vi.mock('@/lib/github/userRepos', async (importOriginal) => {
  const actual = await importOriginal<typeof UserReposModule>();
  return { ...actual, listAccessibleRepos: mocks.listAccessibleRepos };
});

vi.mock('@/lib/db/linkAdmin', () => ({
  listLinksForRepoIds: mocks.listLinksForRepoIds,
  upsertProjectLink: mocks.upsertProjectLink,
  deleteProjectLink: mocks.deleteProjectLink,
}));

import { DELETE, GET, POST } from '@/app/api/links/route';
import { SESSION_COOKIE, sealSession } from '@/lib/auth/session';
import type { DashboardEnv } from '@/config/env';
import type { AccessibleRepo } from '@/lib/github/userRepos';

const SESSION_SECRET = 'a'.repeat(32);
const FAKE_ENV: DashboardEnv = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  appSlug: 'guardrail-test',
  sessionSecret: SESSION_SECRET,
  baseUrl: 'https://example.test',
};
const FAKE_DB = { marker: 'fake-db' };

function sessionCookie(overrides?: Partial<{ userId: number; login: string; token: string }>): string {
  const sealed = sealSession(
    {
      token: overrides?.token ?? 'gh-user-token',
      login: overrides?.login ?? 'octocat',
      userId: overrides?.userId ?? 1,
      expiresAt: Date.now() + 60_000,
    },
    SESSION_SECRET,
  );
  return `${SESSION_COOKIE}=${sealed}`;
}

function makeRequest(opts: {
  method: string;
  url?: string;
  cookie?: string | null;
  csrf?: boolean;
  body?: unknown;
}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.csrf) headers.set('x-guardrail-request', 'dashboard');
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(opts.url ?? 'http://localhost/api/links', {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildDashboardDeps.mockReturnValue({ env: FAKE_ENV, db: FAKE_DB });
});

describe('GET /api/links', () => {
  it('21. no session cookie -> 401', async () => {
    const res = await GET(makeRequest({ method: 'GET' }));

    expect(res.status).toBe(401);
    expect(mocks.listAccessibleRepos).not.toHaveBeenCalled();
  });
});

describe('POST /api/links', () => {
  it('22. missing csrf header -> 403 (even with a valid session cookie)', async () => {
    const res = await POST(
      makeRequest({ method: 'POST', cookie: sessionCookie(), body: { backendRepoId: 1, frontendRepoId: 2 } }),
    );

    expect(res.status).toBe(403);
    expect(mocks.upsertProjectLink).not.toHaveBeenCalled();
  });

  it('23. body validation failures -> 400 (bad ids / ".." path / leading "/")', async () => {
    const cookie = sessionCookie();

    const badIds = await POST(
      makeRequest({ method: 'POST', cookie, csrf: true, body: { backendRepoId: -1, frontendRepoId: 2 } }),
    );
    expect(badIds.status).toBe(400);

    const dotDotPath = await POST(
      makeRequest({
        method: 'POST',
        cookie,
        csrf: true,
        body: { backendRepoId: 1, frontendRepoId: 2, openapiFilePath: '../secret.json' },
      }),
    );
    expect(dotDotPath.status).toBe(400);

    const leadingSlash = await POST(
      makeRequest({
        method: 'POST',
        cookie,
        csrf: true,
        body: { backendRepoId: 1, frontendRepoId: 2, frontendSrcDirectory: '/etc' },
      }),
    );
    expect(leadingSlash.status).toBe(400);

    expect(mocks.upsertProjectLink).not.toHaveBeenCalled();
  });

  it('24. authorization failure propagates status + reason (accessible repos stubbed via mocked userRepos)', async () => {
    mocks.listAccessibleRepos.mockResolvedValue([] satisfies AccessibleRepo[]);

    const res = await POST(
      makeRequest({
        method: 'POST',
        cookie: sessionCookie(),
        csrf: true,
        body: { backendRepoId: 1, frontendRepoId: 2 },
      }),
    );

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('backend repository not found in your app installations');
    expect(mocks.upsertProjectLink).not.toHaveBeenCalled();
  });

  it('25. happy path -> upsert called with session identity + defaulted paths', async () => {
    mocks.listAccessibleRepos.mockResolvedValue([
      { id: 1, fullName: 'acme/backend', owner: 'acme', name: 'backend', canAdminister: true, installationId: 9 },
      { id: 2, fullName: 'acme/frontend', owner: 'acme', name: 'frontend', canAdminister: false, installationId: 9 },
    ] satisfies AccessibleRepo[]);
    mocks.upsertProjectLink.mockResolvedValue(undefined);

    const res = await POST(
      makeRequest({
        method: 'POST',
        cookie: sessionCookie({ userId: 42, login: 'octocat' }),
        csrf: true,
        body: { backendRepoId: 1, frontendRepoId: 2 },
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.upsertProjectLink).toHaveBeenCalledTimes(1);
    expect(mocks.upsertProjectLink).toHaveBeenCalledWith(FAKE_DB, {
      backend_repo_id: 1,
      frontend_repo_id: 2,
      openapi_file_path: 'openapi.json',
      frontend_src_directory: 'src',
      created_by_github_id: 42,
      created_by_login: 'octocat',
    });

    const json = (await res.json()) as { link: Record<string, unknown> };
    expect(json.link).toMatchObject({ backend_repo_id: 1, frontend_repo_id: 2 });
  });
});

describe('DELETE /api/links', () => {
  it('26. happy path -> 204', async () => {
    mocks.listAccessibleRepos.mockResolvedValue([
      { id: 1, fullName: 'acme/backend', owner: 'acme', name: 'backend', canAdminister: true, installationId: 9 },
    ] satisfies AccessibleRepo[]);
    mocks.deleteProjectLink.mockResolvedValue(undefined);

    const res = await DELETE(
      makeRequest({
        method: 'DELETE',
        url: 'http://localhost/api/links?backendRepoId=1',
        cookie: sessionCookie(),
        csrf: true,
      }),
    );

    expect(res.status).toBe(204);
    expect(mocks.deleteProjectLink).toHaveBeenCalledWith(FAKE_DB, 1);
  });
});
