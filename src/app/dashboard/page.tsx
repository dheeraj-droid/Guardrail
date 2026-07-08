import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadDashboardEnv } from '@/config/env';
import { SESSION_COOKIE, unsealSession } from '@/lib/auth/session';
import { LinkManager } from './LinkManager';

export const runtime = 'nodejs'; // node:crypto (unsealSession)
// This page reads a per-request session cookie and dashboard env config that may not
// exist at build time — it must never be statically prerendered (mirrors the webhook
// route's `dynamic = 'force-dynamic'`; see src/app/api/webhook/github/route.ts).
export const dynamic = 'force-dynamic';

/**
 * Server component shell: resolves the session server-side and passes ONLY the login
 * name to the client — the GitHub user token never reaches client-rendered markup.
 */
export default async function DashboardPage() {
  const env = loadDashboardEnv();
  const cookieStore = await cookies();
  const sealed = cookieStore.get(SESSION_COOKIE)?.value ?? null;
  const session = unsealSession(sealed, env.sessionSecret);

  if (session === null) {
    redirect('/');
  }

  return <LinkManager login={session.login} />;
}
