// FROZEN CONTRACT (CLAUDE.md Law 1). Mirrors the project_links table (SRD Module 3).

/** A row of project_links resolving a backend repo to its linked frontend repo. */
export interface ProjectLink {
  id: string;
  backend_repo_id: number;
  frontend_repo_id: number;
  openapi_file_path: string; // default 'openapi.json'
  frontend_src_directory: string; // default 'src'
  created_at: string;
}
