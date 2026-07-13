import { cookies } from 'next/headers';
import { loadDashboardEnv } from '@/config/env';
import { SESSION_COOKIE, unsealSession } from '@/lib/auth/session';

/**
 * Server-only view of the current request's auth state, safe to read from any server
 * component (root layout, landing page).
 *
 * - `configured`: whether the onboarding dashboard is configured on this deployment
 *   (i.e. `loadDashboardEnv()` succeeds). Webhook-only deploys leave this `false`.
 * - `login`: the signed-in GitHub login, or `null` when signed out / not configured.
 *
 * TOLERANT BY DESIGN: `loadDashboardEnv()` throws when dashboard env vars are unset, and
 * this runs in the root layout on EVERY page including webhook-only deploys. Any throw is
 * swallowed and treated as "not configured / signed out" so the header/landing never crash
 * a deployment that only runs the webhook pipeline.
 *
 * Only the `login` string is exposed — never the GitHub user token (SessionData.token),
 * which must never reach client-rendered markup.
 */
export async function resolveSessionState(): Promise<{ configured: boolean; login: string | null }> {
  try {
    const secret = loadDashboardEnv().sessionSecret;
    const cookieStore = await cookies();
    const sealed = cookieStore.get(SESSION_COOKIE)?.value ?? null;
    const session = unsealSession(sealed, secret);
    return { configured: true, login: session?.login ?? null };
  } catch {
    return { configured: false, login: null };
  }
}
