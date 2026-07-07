import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectLink } from '@/types/db';

// This module is the ONLY place that queries project_links (Spec D). The client is
// injected — never construct it or read env.ts here (client is injected; Spec D "Forbidden").

/**
 * Look up the link row for a backend repository.
 * Returns null when the repo is not registered.
 *
 * @throws Error when the underlying query returns an error.
 */
export async function getProjectLinkByBackendRepoId(
  db: SupabaseClient,
  backendRepoId: number,
): Promise<ProjectLink | null> {
  const { data, error } = await db
    .from('project_links')
    .select('*')
    .eq('backend_repo_id', backendRepoId)
    .maybeSingle();

  if (error) {
    throw new Error('project_links lookup failed: ' + error.message);
  }

  if (data === null || data === undefined) {
    return null;
  }

  // MONOREPO (SRD §3, CLAUDE.md Law 8): backend_repo_id === frontend_repo_id is a VALID
  // row — only the backend column is UNIQUE. No validation may reject this case.
  //
  // Defaults applied defensively: DB defaults exist, but rows inserted by hand may carry
  // NULLs, so SRD defaults win here (Spec D).
  return {
    id: data.id,
    backend_repo_id: data.backend_repo_id,
    frontend_repo_id: data.frontend_repo_id,
    openapi_file_path: data.openapi_file_path ?? 'openapi.json',
    frontend_src_directory: data.frontend_src_directory ?? 'src',
    created_at: data.created_at,
  };
}
