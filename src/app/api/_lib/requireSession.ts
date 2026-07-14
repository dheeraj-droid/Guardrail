// Spec K §8 — shared HTTP-layer helpers for auth/dashboard routes. NOT a route file: the
// `_` prefix opts this folder out of Next.js routing entirely, and a route.ts may export
// ONLY HTTP handlers + segment config (route-file law) — so session reading, CSRF
// checking, and dependency construction all live here instead.
//
// ACCEPTED RISK (T5, from the security audit): there is NO app-level rate limiting on the
// dashboard/auth routes. A caller can hammer these endpoints as fast as the platform lets
// them. Accepted because the sensitive mutations are all authorization-gated (authorizeLink
// against a server-fetched accessible list) and the OAuth callback is CSRF-protected by the
// single-use state cookie; abuse is bounded by GitHub's own rate limits on the upstream
// calls. Deploy behind a platform/edge rate limiter (e.g. Vercel/WAF) if stricter limits
// are required.
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadDashboardEnv, loadEnv, type DashboardEnv } from '@/config/env';
import { createDbClient } from '@/lib/db/supabase';
import { SESSION_COOKIE, unsealSession, type SessionData } from '@/lib/auth/session';

export interface DashboardContext {
  session: SessionData;
  env: DashboardEnv;
}

/** Parse a raw `Cookie` request header into a name -> value map (no cookie library). */
function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    cookies[name] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/** Read + unseal the session cookie. Never throws — anything invalid reads as `null`. */
export function readSession(req: Request, env: DashboardEnv): SessionData | null {
  const cookies = parseCookies(req.headers.get('cookie'));
  const raw = cookies[SESSION_COOKIE];
  return unsealSession(raw, env.sessionSecret);
}

/** 401 JSON `{error}` when no valid session is present; otherwise the resolved context. */
export function requireSession(req: Request, env: DashboardEnv): DashboardContext | Response {
  const session = readSession(req, env);
  if (session === null) {
    return Response.json({ error: 'not signed in' }, { status: 401 });
  }
  return { session, env };
}

/**
 * Cheap, effective CSRF defense for a same-site cookie-authenticated JSON API: browsers
 * cannot attach a custom header to a cross-site request without a CORS preflight, and the
 * dashboard's own origin is the only one that ever sends this header.
 */
export function requireCsrf(req: Request): Response | null {
  if (req.headers.get('x-guardrail-request') !== 'dashboard') {
    return Response.json({ error: 'missing csrf header' }, { status: 403 });
  }
  return null;
}

/**
 * Lazily builds dashboard deps. Never called at module top level — keeps route module
 * imports side-effect free for tests/builds that never configure the dashboard.
 */
export function buildDashboardDeps(): { env: DashboardEnv; db: SupabaseClient } {
  const env = loadDashboardEnv();
  const db = createDbClient(loadEnv());
  return { env, db };
}
