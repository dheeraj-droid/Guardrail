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

/** Create or update the link row for `row.backend_repo_id` (the UNIQUE column). */
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
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'backend_repo_id' });

  if (error) {
    throw new Error('project_links upsert failed: ' + error.message);
  }
}

export async function deleteProjectLink(db: SupabaseClient, backendRepoId: number): Promise<void> {
  const { error } = await db.from('project_links').delete().eq('backend_repo_id', backendRepoId);

  if (error) {
    throw new Error('project_links delete failed: ' + error.message);
  }
}
