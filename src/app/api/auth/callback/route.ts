// Spec K — OAuth callback. route.ts exports ONLY handlers + segment config.
import { loadDashboardEnv } from '@/config/env';
import { timingSafeEqual } from 'node:crypto';
import { exchangeCodeForToken, fetchViewer, STATE_COOKIE } from '@/lib/auth/oauth';
import { getUserClient } from '@/lib/github/client';
import { SESSION_COOKIE, SESSION_TTL_MS, sealSession } from '@/lib/auth/session';

export const runtime = 'nodejs'; // node:crypto (sealSession)

const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/**
 * Constant-time string equality over UTF-8 bytes. Length mismatch → false without calling
 * timingSafeEqual (which THROWS on differing lengths). Guards the OAuth state compare
 * against timing side channels (T5).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Read one named cookie's raw value out of a `Cookie` request header. */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

function redirectTo(location: string, extraSetCookie?: string): Response {
  const headers = new Headers({ Location: location });
  headers.append('Set-Cookie', CLEAR_STATE_COOKIE);
  if (extraSetCookie) headers.append('Set-Cookie', extraSetCookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(req: Request): Promise<Response> {
  try {
    const env = loadDashboardEnv();
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = readCookie(req.headers.get('cookie'), STATE_COOKIE);

    // MUST: state param present AND equal to the STATE_COOKIE value, else 403. The state
    // cookie is cleared in the response EITHER WAY (single-use, whether it matched or not).
    // Constant-time compare (safeEqual) — never `===` on the state values (T5).
    if (!state || !cookieState || !safeEqual(state, cookieState)) {
      const headers = new Headers();
      headers.append('Set-Cookie', CLEAR_STATE_COOKIE);
      return Response.json({ error: 'invalid oauth state' }, { status: 403, headers });
    }

    if (!code) {
      return redirectTo(`${env.baseUrl}/?error=auth`);
    }

    try {
      const token = await exchangeCodeForToken({
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        code,
      });
      const viewer = await fetchViewer(getUserClient(token));

      const sealed = sealSession(
        { token, login: viewer.login, userId: viewer.id, expiresAt: Date.now() + SESSION_TTL_MS },
        env.sessionSecret,
      );

      const sessionCookie = `${SESSION_COOKIE}=${sealed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`;
      return redirectTo(`${env.baseUrl}/dashboard`, sessionCookie);
    } catch (authError) {
      // Never a 5xx with details on an auth failure — bounce back to the landing page.
      console.error(
        '[guardrail-dash] oauth exchange failed:',
        authError instanceof Error ? authError.message : String(authError),
      );
      return redirectTo(`${env.baseUrl}/?error=auth`);
    }
  } catch (error) {
    console.error(
      '[guardrail-dash] GET /api/auth/callback failed:',
      error instanceof Error ? error.message : String(error),
    );
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
