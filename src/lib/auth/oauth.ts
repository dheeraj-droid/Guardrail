// Spec K — GitHub OAuth (user-to-server) round trip helpers.
import { randomBytes } from 'node:crypto';
import type { Octokit } from 'octokit';

export const STATE_COOKIE = 'guardrail_oauth_state';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Build the GitHub authorize URL. GitHub Apps ignore the `scope` query parameter for
 * user-to-server auth (permissions are whatever the App itself was granted) — do NOT
 * add one here.
 */
export function buildAuthorizeUrl(opts: { clientId: string; baseUrl: string; state: string }): string {
  const { clientId, baseUrl, state } = opts;
  const redirectUri = `${baseUrl}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** 32 hex characters (16 random bytes) — the CSRF state token for the OAuth round trip. */
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Exchange an OAuth `code` for a user access token. This is the ONE sanctioned
 * non-Octokit HTTP call in the codebase: `github.com/login/oauth/access_token` is a web
 * endpoint, not the REST API, so there is no Octokit route for it.
 */
export async function exchangeCodeForToken(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  fetchImpl?: typeof fetch; // injection seam for tests; default globalThis.fetch
}): Promise<string> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;

  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
    }),
  });

  const payload = (await response.json()) as { access_token?: unknown; error?: unknown };
  const token = payload.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    const reason = typeof payload.error === 'string' ? payload.error : 'unknown';
    throw new Error(`OAuth code exchange failed: ${reason}`);
  }
  return token;
}

/** The signed-in user's identity, via the user-authenticated Octokit client. */
export async function fetchViewer(octokit: Octokit): Promise<{ login: string; id: number }> {
  const { data } = await octokit.request('GET /user');
  return { login: data.login, id: data.id };
}
