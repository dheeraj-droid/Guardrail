import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as EnvModule from '@/config/env';

// resolveSessionState() reads two dependencies: `loadDashboardEnv()` (env) and the
// request's cookie store via `cookies()` from next/headers. Both are mocked here so the
// test controls the deployment shape (configured vs. not) and the presented cookie,
// while the real seal/unseal crypto runs end to end. Pattern mirrors
// tests/dashboard/authRoutes.test.ts.
const mocks = vi.hoisted(() => ({
  loadDashboardEnv: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, loadDashboardEnv: mocks.loadDashboardEnv };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
}));

import { resolveSessionState } from '@/app/sessionState';
import { SESSION_COOKIE, sealSession, type SessionData } from '@/lib/auth/session';
import type { DashboardEnv } from '@/config/env';

const SESSION_SECRET = 'a'.repeat(32);
const FAKE_ENV: DashboardEnv = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  appSlug: 'guardrail-test',
  sessionSecret: SESSION_SECRET,
  baseUrl: 'https://example.test',
};

function session(overrides: Partial<SessionData> = {}): SessionData {
  return {
    token: 'gho_token',
    login: 'octocat',
    userId: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** Make the mocked cookie store present the given sealed value for SESSION_COOKIE. */
function presentCookie(value: string | null): void {
  mocks.cookieGet.mockImplementation((name: string) =>
    name === SESSION_COOKIE && value !== null ? { value } : undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSessionState', () => {
  it('dashboard env unset -> { configured: false, login: null }', async () => {
    mocks.loadDashboardEnv.mockImplementation(() => {
      throw new Error('Missing required env var: GITHUB_APP_CLIENT_ID');
    });
    presentCookie('anything');

    expect(await resolveSessionState()).toEqual({ configured: false, login: null });
    // cookies() must never be consulted once the deployment is unconfigured.
    expect(mocks.cookieGet).not.toHaveBeenCalled();
  });

  it('configured + valid sealed cookie -> login returned', async () => {
    mocks.loadDashboardEnv.mockReturnValue(FAKE_ENV);
    presentCookie(sealSession(session({ login: 'octocat' }), SESSION_SECRET));

    expect(await resolveSessionState()).toEqual({ configured: true, login: 'octocat' });
  });

  it('configured + expired sealed cookie -> configured, login null', async () => {
    mocks.loadDashboardEnv.mockReturnValue(FAKE_ENV);
    presentCookie(sealSession(session({ expiresAt: Date.now() - 1 }), SESSION_SECRET));

    expect(await resolveSessionState()).toEqual({ configured: true, login: null });
  });

  it('configured + absent cookie -> configured, login null', async () => {
    mocks.loadDashboardEnv.mockReturnValue(FAKE_ENV);
    presentCookie(null);

    expect(await resolveSessionState()).toEqual({ configured: true, login: null });
  });
});
