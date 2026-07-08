// Spec K — the authorization law. PURE and independently testable: this is the ONE place
// that decides whether a signed-in user may create/edit/delete a project_links row for a
// given (backendRepoId, frontendRepoId) pair. Callers must NEVER trust client-supplied
// repo ids without running this against a server-fetched `accessible` list.

/** A repo the signed-in user can reach through an App installation (see userRepos.ts). */
export interface RepoAccess {
  id: number;
  fullName: string; // "owner/name"
  canAdminister: boolean; // permissions.admin === true || permissions.maintain === true
}

export type AuthzResult =
  | { ok: true; backend: RepoAccess; frontend: RepoAccess }
  | { ok: false; status: 403 | 404; reason: string };

/**
 * Rules, evaluated in order:
 * 1. backend not in `accessible` -> 404 (never 403 — do not leak that the repo exists).
 * 2. backend found but lacks admin/maintain -> 403.
 * 3. frontend not in `accessible` -> 404 (the App must cover it or the pipeline could
 *    never scan it).
 * 4. Monorepo (backendRepoId === frontendRepoId) is VALID (CLAUDE.md Law 8) — rules 1-2
 *    already cover it: the same accessible entry is found for both ids.
 * 5. Otherwise ok, carrying both resolved RepoAccess records.
 */
export function authorizeLink(opts: {
  backendRepoId: number;
  frontendRepoId: number;
  accessible: readonly RepoAccess[];
}): AuthzResult {
  const { backendRepoId, frontendRepoId, accessible } = opts;

  const backend = accessible.find((r) => r.id === backendRepoId);
  if (backend === undefined) {
    return {
      ok: false,
      status: 404,
      reason: 'backend repository not found in your app installations',
    };
  }

  if (!backend.canAdminister) {
    return {
      ok: false,
      status: 403,
      reason: 'you need admin or maintain permission on the backend repository',
    };
  }

  const frontend = accessible.find((r) => r.id === frontendRepoId);
  if (frontend === undefined) {
    return {
      ok: false,
      status: 404,
      reason: 'frontend repository not found in your app installations',
    };
  }

  return { ok: true, backend, frontend };
}
