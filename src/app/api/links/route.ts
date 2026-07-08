// Spec K — link CRUD. route.ts exports ONLY handlers + segment config (route-file law).
// Every mutation re-fetches the user's accessible repos with their SESSION token and runs
// authorizeLink server-side — client-supplied repo ids are never trusted directly.
import { buildDashboardDeps, requireCsrf, requireSession } from '@/app/api/_lib/requireSession';
import { authorizeLink, type RepoAccess } from '@/lib/auth/authorize';
import { getUserClient } from '@/lib/github/client';
import { listAccessibleRepos, toRepoAccess } from '@/lib/github/userRepos';
import { deleteProjectLink, listLinksForRepoIds, upsertProjectLink } from '@/lib/db/linkAdmin';

export const runtime = 'nodejs';

const MAX_PATH_LENGTH = 255;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

type PathResult = { ok: true; value: string } | { ok: false; reason: string };

/** Validate + default one of the two path-like fields (spec K §8 rules, exact order). */
function parsePathField(value: unknown, fallback: string, fieldName: string): PathResult {
  let candidate: string;
  if (value === undefined || value === null) {
    candidate = '';
  } else if (typeof value === 'string') {
    candidate = value;
  } else {
    return { ok: false, reason: `${fieldName} must be a string` };
  }

  const trimmed = candidate.trim();
  const resolved = trimmed === '' ? fallback : trimmed;

  if (resolved.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `${fieldName} must be ${MAX_PATH_LENGTH} characters or fewer` };
  }
  if (resolved.startsWith('/')) {
    return { ok: false, reason: `${fieldName} must not start with "/"` };
  }
  if (resolved.includes('..') || resolved.includes('\\')) {
    return { ok: false, reason: `${fieldName} must not contain ".." or "\\"` };
  }

  return { ok: true, value: resolved };
}

interface ParsedLinkBody {
  backendRepoId: number;
  frontendRepoId: number;
  openapiFilePath: string;
  frontendSrcDirectory: string;
}

function parseLinkBody(body: unknown): { ok: true; value: ParsedLinkBody } | { ok: false; reason: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'request body must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;

  if (!isPositiveInteger(raw.backendRepoId)) {
    return { ok: false, reason: 'backendRepoId must be a positive integer' };
  }
  if (!isPositiveInteger(raw.frontendRepoId)) {
    return { ok: false, reason: 'frontendRepoId must be a positive integer' };
  }

  const openapiFilePath = parsePathField(raw.openapiFilePath, 'openapi.json', 'openapiFilePath');
  if (!openapiFilePath.ok) return openapiFilePath;

  const frontendSrcDirectory = parsePathField(raw.frontendSrcDirectory, 'src', 'frontendSrcDirectory');
  if (!frontendSrcDirectory.ok) return frontendSrcDirectory;

  return {
    ok: true,
    value: {
      backendRepoId: raw.backendRepoId,
      frontendRepoId: raw.frontendRepoId,
      openapiFilePath: openapiFilePath.value,
      frontendSrcDirectory: frontendSrcDirectory.value,
    },
  };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { env, db } = buildDashboardDeps();
    const ctx = requireSession(req, env);
    if (ctx instanceof Response) return ctx;

    const accessible = await listAccessibleRepos(getUserClient(ctx.session.token));
    const links = await listLinksForRepoIds(
      db,
      accessible.map((r) => r.id),
    );
    return Response.json({ links }, { status: 200 });
  } catch (error) {
    console.error('[guardrail-dash] GET /api/links failed:', errorMessage(error));
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { env, db } = buildDashboardDeps();
    const ctx = requireSession(req, env);
    if (ctx instanceof Response) return ctx;
    const csrf = requireCsrf(req);
    if (csrf) return csrf;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
    }

    const parsed = parseLinkBody(body);
    if (!parsed.ok) {
      return Response.json({ error: parsed.reason }, { status: 400 });
    }

    // NEVER trust client-supplied repo ids: re-fetch what this user can access right now,
    // with their own session token, and run the authorization law against that.
    const accessibleRepos = await listAccessibleRepos(getUserClient(ctx.session.token));
    const accessible: RepoAccess[] = accessibleRepos.map(toRepoAccess);
    const authz = authorizeLink({
      backendRepoId: parsed.value.backendRepoId,
      frontendRepoId: parsed.value.frontendRepoId,
      accessible,
    });
    if (!authz.ok) {
      return Response.json({ error: authz.reason }, { status: authz.status });
    }

    const link = {
      backend_repo_id: parsed.value.backendRepoId,
      frontend_repo_id: parsed.value.frontendRepoId,
      openapi_file_path: parsed.value.openapiFilePath,
      frontend_src_directory: parsed.value.frontendSrcDirectory,
      created_by_github_id: ctx.session.userId,
      created_by_login: ctx.session.login,
    };
    await upsertProjectLink(db, link);

    return Response.json({ link }, { status: 200 });
  } catch (error) {
    console.error('[guardrail-dash] POST /api/links failed:', errorMessage(error));
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { env, db } = buildDashboardDeps();
    const ctx = requireSession(req, env);
    if (ctx instanceof Response) return ctx;
    const csrf = requireCsrf(req);
    if (csrf) return csrf;

    const url = new URL(req.url);
    const raw = url.searchParams.get('backendRepoId');
    const backendRepoId = raw === null ? Number.NaN : Number(raw);
    if (!isPositiveInteger(backendRepoId)) {
      return Response.json({ error: 'backendRepoId must be a positive integer' }, { status: 400 });
    }

    // Delete needs only backend admin — authorize with frontendRepoId = backendRepoId.
    const accessibleRepos = await listAccessibleRepos(getUserClient(ctx.session.token));
    const accessible: RepoAccess[] = accessibleRepos.map(toRepoAccess);
    const authz = authorizeLink({ backendRepoId, frontendRepoId: backendRepoId, accessible });
    if (!authz.ok) {
      return Response.json({ error: authz.reason }, { status: authz.status });
    }

    await deleteProjectLink(db, backendRepoId);
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('[guardrail-dash] DELETE /api/links failed:', errorMessage(error));
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
