import { describe, it, expect, vi, beforeEach } from 'vitest';

// These routes call `loadDashboardEnv()` directly (not `buildDashboardDeps()`), so the env
// module is partially mocked here: `loadDashboardEnv` is a mock, everything else (including
// `loadEnv`, untouched by these routes) stays real. `exchangeCodeForToken`/`fetchViewer` are
// mocked (the only network-shaped calls in this flow); `STATE_COOKIE`, `buildAuthorizeUrl`,
// and `generateState` run for REAL, so the actual state-cookie/CSRF wiring in the routes is
// genuinely exercised end to end. No network calls anywhere in this file.
const mocks = vi.hoisted(() => ({
  loadDashboardEnv: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  fetchViewer: vi.fn(),
}));

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env')>();
  return { ...actual, loadDashboardEnv: mocks.loadDashboardEnv };
});

vi.mock('@/lib/auth/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/oauth')>();
  return { ...actual, exchangeCodeForToken: mocks.exchangeCodeForToken, fetchViewer: mocks.fetchViewer };
});

import { GET as loginGET } from '@/app/api/auth/login/route';
import { GET as callbackGET } from '@/app/api/auth/callback/route';
import { POST as logoutPOST } from '@/app/api/auth/logout/route';
import { STATE_COOKIE } from '@/lib/auth/oauth';
import { SESSION_COOKIE, SESSION_TTL_MS, unsealSession } from '@/lib/auth/session';
import type { DashboardEnv } from '@/config/env';

const SESSION_SECRET = 'a'.repeat(32);
const FAKE_ENV: DashboardEnv = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  appSlug: 'guardrail-test',
  sessionSecret: SESSION_SECRET,
  baseUrl: 'https://example.test',
};

/** Find one `Set-Cookie` response header by cookie name (there may be several). */
function findSetCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

/** Extract just the value segment (before the first `;`) of a raw `Set-Cookie` string. */
function cookieValue(cookieString: string): string {
  const eq = cookieString.indexOf('=');
  return cookieString
    .slice(eq + 1)
    .split(';')[0]!
    .trim();
}

function callbackRequest(opts: { code?: string; state?: string; stateCookie?: string }): Request {
  const url = new URL('http://localhost/api/auth/callback');
  if (opts.code !== undefined) url.searchParams.set('code', opts.code);
  if (opts.state !== undefined) url.searchParams.set('state', opts.state);
  const headers = new Headers();
  if (opts.stateCookie !== undefined) headers.set('cookie', `${STATE_COOKIE}=${opts.stateCookie}`);
  return new Request(url, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadDashboardEnv.mockReturnValue(FAKE_ENV);
});

describe('GET /api/auth/login', () => {
  it('L1. 302 to the github authorize URL with client_id, url-encoded redirect_uri, and state (no scope param)', async () => {
    const res = await loginGET();

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBeTruthy();
    expect(location!.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);

    const parsed = new URL(location!);
    expect(parsed.searchParams.get('client_id')).toBe(FAKE_ENV.clientId);
    expect(parsed.searchParams.get('redirect_uri')).toBe(`${FAKE_ENV.baseUrl}/api/auth/callback`);
    expect(parsed.searchParams.has('state')).toBe(true);
    expect(parsed.searchParams.get('state')).not.toBe('');
    expect(parsed.searchParams.has('scope')).toBe(false);

    // redirect_uri must actually be percent-encoded in the raw query string, not just
    // decodable via URL parsing.
    expect(location).toContain(
      `redirect_uri=${encodeURIComponent(`${FAKE_ENV.baseUrl}/api/auth/callback`)}`,
    );
  });

  it('L2. sets guardrail_oauth_state cookie (HttpOnly, Secure, SameSite=Lax, Max-Age=600) whose value equals the state in Location', async () => {
    const res = await loginGET();

    const location = res.headers.get('location')!;
    const stateInUrl = new URL(location).searchParams.get('state');

    const cookie = findSetCookie(res, STATE_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Path=/');
    expect(cookieValue(cookie!)).toBe(stateInUrl);
  });

  it('L3. two consecutive calls produce different state values (freshness)', async () => {
    const res1 = await loginGET();
    const res2 = await loginGET();

    const state1 = new URL(res1.headers.get('location')!).searchParams.get('state');
    const state2 = new URL(res2.headers.get('location')!).searchParams.get('state');

    expect(state1).not.toBe(state2);
  });
});

describe('GET /api/auth/callback', () => {
  it('C1. missing state param -> 403 + state cookie cleared', async () => {
    const res = await callbackGET(callbackRequest({ code: 'irrelevant', stateCookie: 'cookie-state' }));

    expect(res.status).toBe(403);
    const cookie = findSetCookie(res, STATE_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookieValue(cookie!)).toBe('');
    expect(cookie).toContain('Max-Age=0');
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('C2. missing state cookie -> 403', async () => {
    const res = await callbackGET(callbackRequest({ code: 'irrelevant', state: 'param-state' }));

    expect(res.status).toBe(403);
    const cookie = findSetCookie(res, STATE_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookie).toContain('Max-Age=0');
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('C3. state param does not equal cookie state -> 403 + state cookie cleared', async () => {
    const res = await callbackGET(
      callbackRequest({ code: 'irrelevant', state: 'param-state', stateCookie: 'different-cookie-state' }),
    );

    expect(res.status).toBe(403);
    const cookie = findSetCookie(res, STATE_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookieValue(cookie!)).toBe('');
    expect(cookie).toContain('Max-Age=0');
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('C4. valid state but missing code -> 302 to /?error=auth, state cookie cleared, no session cookie', async () => {
    const res = await callbackGET(callbackRequest({ state: 'matching-state', stateCookie: 'matching-state' }));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${FAKE_ENV.baseUrl}/?error=auth`);

    const stateCookie = findSetCookie(res, STATE_COOKIE);
    expect(stateCookie).toBeTruthy();
    expect(cookieValue(stateCookie!)).toBe('');
    expect(stateCookie).toContain('Max-Age=0');

    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('C5. happy path -> 302 to /dashboard; state cookie cleared; session cookie set and unseals correctly', async () => {
    mocks.exchangeCodeForToken.mockResolvedValue('gh-user-token-xyz');
    mocks.fetchViewer.mockResolvedValue({ login: 'octocat', id: 583231 });

    const before = Date.now();
    const res = await callbackGET(
      callbackRequest({ code: 'good-code', state: 'matching-state', stateCookie: 'matching-state' }),
    );
    const after = Date.now();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${FAKE_ENV.baseUrl}/dashboard`);

    const stateCookie = findSetCookie(res, STATE_COOKIE);
    expect(stateCookie).toBeTruthy();
    expect(cookieValue(stateCookie!)).toBe('');
    expect(stateCookie).toContain('Max-Age=0');

    const sessionCookie = findSetCookie(res, SESSION_COOKIE);
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Max-Age=28800');
    expect(sessionCookie).toContain('Path=/');

    const sealed = cookieValue(sessionCookie!);
    const unsealed = unsealSession(sealed, SESSION_SECRET);
    expect(unsealed).not.toBeNull();
    expect(unsealed!.token).toBe('gh-user-token-xyz');
    expect(unsealed!.login).toBe('octocat');
    expect(unsealed!.userId).toBe(583231);
    expect(unsealed!.expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(unsealed!.expiresAt).toBeLessThanOrEqual(after + SESSION_TTL_MS);
  });

  it('C6. exchangeCodeForToken rejects -> 302 to /?error=auth, no session cookie', async () => {
    mocks.exchangeCodeForToken.mockRejectedValue(new Error('bad_verification_code'));

    const res = await callbackGET(
      callbackRequest({ code: 'bad-code', state: 'matching-state', stateCookie: 'matching-state' }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${FAKE_ENV.baseUrl}/?error=auth`);
    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
    expect(mocks.fetchViewer).not.toHaveBeenCalled();
  });

  it('C7. TOKEN-LEAK GUARD: the raw token never appears literally in any header or body (only recoverable by unsealing the session cookie)', async () => {
    const SECRET_TOKEN = 'ultra-secret-gh-user-token-must-never-leak-9f8e7d6c';
    mocks.exchangeCodeForToken.mockResolvedValue(SECRET_TOKEN);
    mocks.fetchViewer.mockResolvedValue({ login: 'octocat', id: 583231 });

    const res = await callbackGET(
      callbackRequest({ code: 'good-code', state: 'matching-state', stateCookie: 'matching-state' }),
    );

    const bodyText = await res.text();
    // `Headers.entries()` requires the `DOM.Iterable` lib, which this project's tsconfig
    // does not include — `forEach` is part of the base `Headers` interface instead.
    const headerParts: string[] = [];
    res.headers.forEach((value, key) => headerParts.push(`${key}: ${value}`));
    const fullText = `${headerParts.join('\n')}\n${bodyText}`;

    expect(fullText).not.toContain(SECRET_TOKEN);

    // Sanity check so the assertion above isn't vacuously true: the token IS present in the
    // response, but only recoverable by unsealing the session cookie with the secret.
    const sealed = cookieValue(findSetCookie(res, SESSION_COOKIE)!);
    const unsealed = unsealSession(sealed, SESSION_SECRET);
    expect(unsealed?.token).toBe(SECRET_TOKEN);
  });
});

describe('POST /api/auth/logout', () => {
  it('O1. missing x-guardrail-request: dashboard header -> 403', async () => {
    const res = await logoutPOST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));

    expect(res.status).toBe(403);
    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
  });

  it('O2. with the header -> 204 and session cookie cleared', async () => {
    const headers = new Headers({ 'x-guardrail-request': 'dashboard' });
    const res = await logoutPOST(new Request('http://localhost/api/auth/logout', { method: 'POST', headers }));

    expect(res.status).toBe(204);
    const cookie = findSetCookie(res, SESSION_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookieValue(cookie!)).toBe('');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });
});
