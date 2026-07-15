import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectLink } from '@/types/db';

// Spec K — dashboard-only db access. The client is injected, exactly like
// projectLinks.ts (Spec D) — never construct it or read env here.

/** A project_links row plus the dashboard ownership metadata (migration 0002). */
export type ProjectLinkRow = ProjectLink & { created_by_login?: string | null };

/**
 * All link rows for a set of backend repo ids — the set a signed-in user can access.
 * Empty input short-circuits to `[]` with zero db calls.
 */
export async function listLinksForRepoIds(
  db: SupabaseClient,
  backendRepoIds: readonly number[],
): Promise<ProjectLinkRow[]> {
  if (backendRepoIds.length === 0) return [];

  const { data, error } = await db
    .from('project_links')
    .select('*')
    .in('backend_repo_id', [...backendRepoIds]);

  if (error) {
    throw new Error('project_links list failed: ' + error.message);
  }

  return (data ?? []) as ProjectLinkRow[];
}

/**
 * Create or update the link row for the (backend_repo_id, frontend_repo_id) PAIR — the
 * composite UNIQUE key since migration 0005 dropped the single-column backend uniqueness
 * and added `UNIQUE (backend_repo_id, frontend_repo_id)`. A backend repo may link to many
 * frontend repos, so the conflict target must be BOTH columns; targeting only
 * `backend_repo_id` (the pre-0005 constraint, now gone) 500s on a migrated DB.
 */
export async function upsertProjectLink(
  db: SupabaseClient,
  row: {
    backend_repo_id: number;
    frontend_repo_id: number;
    openapi_file_path: string;
    frontend_src_directory: string;
    created_by_github_id: number;
    created_by_login: string;
  },
): Promise<void> {
  const { error } = await db
    .from('project_links')
    .upsert(
      { ...row, updated_at: new Date().toISOString() },
      { onConflict: 'backend_repo_id,frontend_repo_id' },
    );

  if (error) {
    throw new Error('project_links upsert failed: ' + error.message);
  }
}

/**
 * Delete exactly ONE link — the (backend_repo_id, frontend_repo_id) pair. This matches the
 * multi-frontend data model (migration 0005): a backend repo may have many frontend links,
 * so deletion is pair-level and must NOT remove the backend's other frontend links.
 */
export async function deleteProjectLink(
  db: SupabaseClient,
  backendRepoId: number,
  frontendRepoId: number,
): Promise<void> {
  const { error } = await db
    .from('project_links')
    .delete()
    .eq('backend_repo_id', backendRepoId)
    .eq('frontend_repo_id', frontendRepoId);

  if (error) {
    throw new Error('project_links delete failed: ' + error.message);
  }
}
