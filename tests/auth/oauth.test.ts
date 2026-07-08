import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from 'octokit';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchViewer, generateState } from '@/lib/auth/oauth';

function mockOctokit(): { octokit: Octokit; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  return { octokit: { request } as unknown as Octokit, request };
}

describe('buildAuthorizeUrl', () => {
  it('6. exact shape: github authorize endpoint, encoded redirect_uri + state, no scope param', () => {
    const url = buildAuthorizeUrl({
      clientId: 'client-123',
      baseUrl: 'https://guardrail-xyz.vercel.app',
      state: 'deadbeef',
    });

    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);

    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('client-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://guardrail-xyz.vercel.app/api/auth/callback',
    );
    expect(parsed.searchParams.get('state')).toBe('deadbeef');
    expect(parsed.searchParams.has('scope')).toBe(false);

    // redirect_uri must actually be percent-encoded in the raw query string.
    expect(url).toContain('redirect_uri=https%3A%2F%2Fguardrail-xyz.vercel.app%2Fapi%2Fauth%2Fcallback');
  });
});

describe('generateState', () => {
  it('generates 32 lowercase hex characters, different each call', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('exchangeCodeForToken', () => {
  it('7. happy path: fetchImpl stub -> resolves the access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ access_token: 'user-token-abc' }),
    });

    const token = await exchangeCodeForToken({
      clientId: 'id',
      clientSecret: 'secret',
      code: 'the-code',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(token).toBe('user-token-abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ accept: 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      client_id: 'id',
      client_secret: 'secret',
      code: 'the-code',
    });
  });

  it('8a. error payload (no access_token) -> throws with the error reason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ error: 'bad_verification_code' }),
    });

    await expect(
      exchangeCodeForToken({
        clientId: 'id',
        clientSecret: 'secret',
        code: 'bad-code',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('OAuth code exchange failed: bad_verification_code');
  });

  it('8b. empty access_token and no error field -> throws with "unknown"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ access_token: '' }),
    });

    await expect(
      exchangeCodeForToken({
        clientId: 'id',
        clientSecret: 'secret',
        code: 'bad-code',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('OAuth code exchange failed: unknown');
  });
});

describe('fetchViewer', () => {
  it('9. maps GET /user response to { login, id }', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: { login: 'octocat', id: 583231 } });

    const viewer = await fetchViewer(octokit);

    expect(viewer).toEqual({ login: 'octocat', id: 583231 });
    const [route] = request.mock.calls[0]!;
    expect(route).toBe('GET /user');
  });
});
