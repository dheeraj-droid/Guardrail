// Spec K — accessible-repo listing for the dashboard UI. route.ts exports ONLY handlers +
// segment config.
import { loadDashboardEnv } from '@/config/env';
import { requireSession } from '@/app/api/_lib/requireSession';
import { getUserClient } from '@/lib/github/client';
import { listAccessibleRepos } from '@/lib/github/userRepos';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const env = loadDashboardEnv();
    const ctx = requireSession(req, env);
    if (ctx instanceof Response) return ctx;

    const repos = await listAccessibleRepos(getUserClient(ctx.session.token));
    return Response.json({ repos }, { status: 200 });
  } catch (error) {
    console.error(
      '[guardrail-dash] GET /api/dashboard/repos failed:',
      error instanceof Error ? error.message : String(error),
    );
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
