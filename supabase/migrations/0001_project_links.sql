-- Cross-repository dependency map (SRD Module 3).
-- Monorepo support: backend_repo_id may EQUAL frontend_repo_id — only the backend
-- column is UNIQUE. Routing then relies on the frontend_src_directory subdirectory
-- prefix instead of a distinct repo id (SRD §3, CLAUDE.md Law 8).
CREATE TABLE project_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backend_repo_id BIGINT NOT NULL UNIQUE,
    frontend_repo_id BIGINT NOT NULL,
    openapi_file_path VARCHAR(255) DEFAULT 'openapi.json',
    frontend_src_directory VARCHAR(255) DEFAULT 'src',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
