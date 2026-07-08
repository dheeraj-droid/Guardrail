// Spec K — session logout. route.ts exports ONLY handlers + segment config.
import { requireCsrf } from '@/app/api/_lib/requireSession';
import { SESSION_COOKIE } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  try {
    const csrf = requireCsrf(req);
    if (csrf) return csrf;

    const headers = new Headers();
    headers.append(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
    return new Response(null, { status: 204, headers });
  } catch (error) {
    console.error(
      '[guardrail-dash] POST /api/auth/logout failed:',
      error instanceof Error ? error.message : String(error),
    );
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
