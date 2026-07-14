import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as EnvModule from '@/config/env';
import type * as OauthModule from '@/lib/auth/oauth';
import type * as UserReposModule from '@/lib/github/userRepos';

// ENCOURAGED bonus coverage: prove the cookies genuinely round-trip across THREE separate
// route modules (login -> callback -> repos) rather than each route test asserting its own
// piece in isolation. Same mocking shape as authRoutes.test.ts/reposRoute.test.ts: only
// `loadDashboardEnv`, the OAuth network call (`exchangeCodeForToken`/`fetchViewer`), and the
// GitHub repos listing (`listAccessibleRepos`) are mocked. `STATE_COOKIE`/`buildAuthorizeUrl`/
// `generateState`, `sealSession`/`unsealSession`, `requireSession`, and `getUserClient` all
// run for REAL. No network calls anywhere in this file.
const mocks = vi.hoisted(() => ({
  loadDashboardEnv: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  fetchViewer: vi.fn(),
  listAccessibleRepos: vi.fn(),
}));

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, loadDashboardEnv: mocks.loadDashboardEnv };
});

vi.mock('@/lib/auth/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof OauthModule>();
  return { ...actual, exchangeCodeForToken: mocks.exchangeCodeForToken, fetchViewer: mocks.fetchViewer };
});

vi.mock('@/lib/github/userRepos', async (importOriginal) => {
  const actual = await importOriginal<typeof UserReposModule>();
  return { ...actual, listAccessibleRepos: mocks.listAccessibleRepos };
});

import { GET as loginGET } from '@/app/api/auth/login/route';
import { GET as callbackGET } from '@/app/api/auth/callback/route';
import { GET as reposGET } from '@/app/api/dashboard/repos/route';
import { STATE_COOKIE } from '@/lib/auth/oauth';
import { SESSION_COOKIE } from '@/lib/auth/session';
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

function findSetCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

function cookieValue(cookieString: string): string {
  const eq = cookieString.indexOf('=');
  return cookieString
    .slice(eq + 1)
    .split(';')[0]!
    .trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadDashboardEnv.mockReturnValue(FAKE_ENV);
});

describe('full OAuth + dashboard flow', () => {
  it('login -> callback -> GET /api/dashboard/repos round-trips the session cookie end to end', async () => {
    // 1. GET /api/auth/login: capture the state cookie the route sets, and the state it
    //    embedded in the Location URL.
    const loginRes = await loginGET();
    expect(loginRes.status).toBe(302);
    const state = new URL(loginRes.headers.get('location')!).searchParams.get('state')!;
    const stateCookieOut = findSetCookie(loginRes, STATE_COOKIE)!;
    const stateCookieForRequest = `${STATE_COOKIE}=${cookieValue(stateCookieOut)}`;
    expect(cookieValue(stateCookieOut)).toBe(state); // the two must genuinely be the same value

    // 2. GET /api/auth/callback, presenting exactly the state param + cookie the browser
    //    would have carried, plus a code. Exchange + viewer lookup are mocked (no network).
    mocks.exchangeCodeForToken.mockResolvedValue('gh-user-token-full-flow');
    mocks.fetchViewer.mockResolvedValue({ login: 'octocat', id: 583231 });

    const callbackUrl = new URL('http://localhost/api/auth/callback');
    callbackUrl.searchParams.set('code', 'good-code');
    callbackUrl.searchParams.set('state', state);
    const callbackReq = new Request(callbackUrl, { headers: { cookie: stateCookieForRequest } });

    const callbackRes = await callbackGET(callbackReq);
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe(`${FAKE_ENV.baseUrl}/dashboard`);

    const sessionCookieOut = findSetCookie(callbackRes, SESSION_COOKIE)!;
    expect(sessionCookieOut).toBeTruthy();
    const sessionCookieForRequest = `${SESSION_COOKIE}=${cookieValue(sessionCookieOut)}`;

    // 3. GET /api/dashboard/repos, presenting exactly the session cookie minted by the
    //    callback above. If the seal/unseal round trip and cookie wiring are both correct,
    //    this resolves as an authenticated request end to end.
    const repos: AccessibleRepo[] = [
      { id: 1, fullName: 'acme/backend', owner: 'acme', name: 'backend', canAdminister: true, installationId: 9 },
    ];
    mocks.listAccessibleRepos.mockResolvedValue(repos);

    const reposRes = await reposGET(
      new Request('http://localhost/api/dashboard/repos', { headers: { cookie: sessionCookieForRequest } }),
    );

    expect(reposRes.status).toBe(200);
    expect(await reposRes.json()).toEqual({ repos });
    expect(mocks.listAccessibleRepos).toHaveBeenCalledTimes(1);
  });
});
