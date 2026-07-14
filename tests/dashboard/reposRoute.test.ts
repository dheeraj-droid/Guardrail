import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as EnvModule from '@/config/env';
import type * as GithubClientModule from '@/lib/github/client';
import type * as UserReposModule from '@/lib/github/userRepos';

// This route calls `loadDashboardEnv()` directly (not `buildDashboardDeps()`), so the env
// module is partially mocked: `loadDashboardEnv` is a mock, everything else stays real.
// `requireSession` (from `@/app/api/_lib/requireSession`) is NOT mocked at all — it runs
// for REAL, so the actual cookie-parsing/unsealing authorization law is genuinely exercised.
// `getUserClient` is mocked so the token it was constructed with can be asserted directly.
// `listAccessibleRepos` is mocked to avoid any real GitHub network call. No network calls
// anywhere in this file.
const mocks = vi.hoisted(() => ({
  loadDashboardEnv: vi.fn(),
  getUserClient: vi.fn(),
  listAccessibleRepos: vi.fn(),
}));

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, loadDashboardEnv: mocks.loadDashboardEnv };
});

vi.mock('@/lib/github/client', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubClientModule>();
  return { ...actual, getUserClient: mocks.getUserClient };
});

vi.mock('@/lib/github/userRepos', async (importOriginal) => {
  const actual = await importOriginal<typeof UserReposModule>();
  return { ...actual, listAccessibleRepos: mocks.listAccessibleRepos };
});

import { GET } from '@/app/api/dashboard/repos/route';
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

function sealedValue(overrides?: Partial<{ userId: number; login: string; token: string }>): string {
  return sealSession(
    {
      token: overrides?.token ?? 'gh-user-token',
      login: overrides?.login ?? 'octocat',
      userId: overrides?.userId ?? 1,
      expiresAt: Date.now() + 60_000,
    },
    SESSION_SECRET,
  );
}

function sessionCookie(overrides?: Partial<{ userId: number; login: string; token: string }>): string {
  return `${SESSION_COOKIE}=${sealedValue(overrides)}`;
}

/** Flip one character inside the auth-tag segment (same tampering technique as session.test.ts). */
function tamperSealedValue(sealed: string): string {
  const parts = sealed.split('.');
  const tag = parts[2]!;
  const flipped = (tag[0] === 'a' ? 'b' : 'a') + tag.slice(1);
  return [parts[0], parts[1], flipped].join('.');
}

function makeRequest(cookie?: string | null): Request {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new Request('http://localhost/api/dashboard/repos', { method: 'GET', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadDashboardEnv.mockReturnValue(FAKE_ENV);
  mocks.getUserClient.mockImplementation((token: string) => ({ __fakeOctokit: true, token }));
});

describe('GET /api/dashboard/repos', () => {
  it('R1. no session cookie -> 401', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mocks.listAccessibleRepos).not.toHaveBeenCalled();
    expect(mocks.getUserClient).not.toHaveBeenCalled();
  });

  it('R2. tampered session cookie (flipped char in the sealed value) -> 401', async () => {
    const tampered = tamperSealedValue(sealedValue());

    const res = await GET(makeRequest(`${SESSION_COOKIE}=${tampered}`));

    expect(res.status).toBe(401);
    expect(mocks.listAccessibleRepos).not.toHaveBeenCalled();
    expect(mocks.getUserClient).not.toHaveBeenCalled();
  });

  it('R3. valid session -> 200 { repos: [...] }; the user client is constructed with the session token', async () => {
    const repos: AccessibleRepo[] = [
      { id: 1, fullName: 'acme/backend', owner: 'acme', name: 'backend', canAdminister: true, installationId: 9 },
      { id: 2, fullName: 'acme/frontend', owner: 'acme', name: 'frontend', canAdminister: false, installationId: 9 },
    ];
    mocks.listAccessibleRepos.mockResolvedValue(repos);

    const res = await GET(makeRequest(sessionCookie({ token: 'the-session-token' })));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { repos: AccessibleRepo[] };
    expect(json).toEqual({ repos });

    expect(mocks.getUserClient).toHaveBeenCalledTimes(1);
    expect(mocks.getUserClient).toHaveBeenCalledWith('the-session-token');
    expect(mocks.listAccessibleRepos).toHaveBeenCalledWith({ __fakeOctokit: true, token: 'the-session-token' });
  });

  it('R4. listAccessibleRepos throws -> 500 generic {error:"internal error"}; no exception message or token leak', async () => {
    const SECRET_TOKEN = 'ghu_super-secret-should-never-leak';
    mocks.listAccessibleRepos.mockRejectedValue(
      new Error(`GitHub API rejected token ${SECRET_TOKEN}: rate limited`),
    );

    const res = await GET(makeRequest(sessionCookie({ token: SECRET_TOKEN })));

    expect(res.status).toBe(500);
    const bodyText = await res.text();
    expect(JSON.parse(bodyText)).toEqual({ error: 'internal error' });
    expect(bodyText).not.toContain(SECRET_TOKEN);
    expect(bodyText).not.toContain('rate limited');

    // `Headers.entries()` requires the `DOM.Iterable` lib, which this project's tsconfig
    // does not include — `forEach` is part of the base `Headers` interface instead.
    const headerParts: string[] = [];
    res.headers.forEach((value, key) => headerParts.push(`${key}: ${value}`));
    expect(headerParts.join('\n')).not.toContain(SECRET_TOKEN);
  });
});
