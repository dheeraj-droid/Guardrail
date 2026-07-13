import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectLink } from '@/types/db';

// This module is the ONLY place that queries project_links (Spec D). The client is
// injected — never construct it or read env.ts here (client is injected; Spec D "Forbidden").

// MONOREPO (SRD §3, CLAUDE.md Law 8): backend_repo_id === frontend_repo_id is a VALID
// row — only the backend column is UNIQUE. No validation may reject this case.
//
// Defaults applied defensively: DB defaults exist, but rows inserted by hand may carry
// NULLs, so SRD defaults win here (Spec D).
//
// Pure row-shaping helper shared by both the singular and plural lookups below (Spec O
// — behavior-preserving extraction, no change to either function's output).
function toProjectLink(row: {
  id: string;
  backend_repo_id: number;
  frontend_repo_id: number;
  openapi_file_path: string | null;
  frontend_src_directory: string | null;
  created_at: string;
}): ProjectLink {
  return {
    id: row.id,
    backend_repo_id: row.backend_repo_id,
    frontend_repo_id: row.frontend_repo_id,
    openapi_file_path: row.openapi_file_path ?? 'openapi.json',
    frontend_src_directory: row.frontend_src_directory ?? 'src',
    created_at: row.created_at,
  };
}

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

  return toProjectLink(data);
}

/**
 * Look up ALL link rows for a backend repository (multi-frontend fan-out). Empty
 * array when the repo is not registered — same "no rows = not registered" contract
 * the singular lookup already has, just plural.
 *
 * @throws Error when the underlying query returns an error.
 */
export async function getProjectLinksByBackendRepoId(
  db: SupabaseClient,
  backendRepoId: number,
): Promise<ProjectLink[]> {
  const { data, error } = await db
    .from('project_links')
    .select('*')
    .eq('backend_repo_id', backendRepoId);

  if (error) {
    throw new Error('project_links lookup failed: ' + error.message);
  }

  if (data === null || data === undefined) {
    return [];
  }

  return data.map(toProjectLink);
}
