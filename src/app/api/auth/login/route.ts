// Spec K — OAuth login kickoff. route.ts exports ONLY handlers + segment config
// (route-file law; see webhook/handler.ts precedent).
import { loadDashboardEnv } from '@/config/env';
import { buildAuthorizeUrl, generateState, STATE_COOKIE } from '@/lib/auth/oauth';

export const runtime = 'nodejs'; // node:crypto (generateState)

export async function GET(): Promise<Response> {
  try {
    const env = loadDashboardEnv();
    const state = generateState();
    const url = buildAuthorizeUrl({ clientId: env.clientId, baseUrl: env.baseUrl, state });

    const headers = new Headers({ Location: url });
    headers.append(
      'Set-Cookie',
      `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error(
      '[guardrail-dash] GET /api/auth/login failed:',
      error instanceof Error ? error.message : String(error),
    );
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
