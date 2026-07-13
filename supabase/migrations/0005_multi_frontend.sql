-- Multi-frontend fan-out (Track O). Drops the one-backend-repo-per-link constraint;
-- a backend repo may now link to more than one frontend repo. Uniqueness moves to the
-- (backend, frontend) pair so the same pair cannot be linked twice.
--
-- Constraint-name assumption: 0001_project_links.sql declares
-- `backend_repo_id BIGINT NOT NULL UNIQUE` with no explicit constraint name, so Postgres
-- auto-generates `project_links_backend_repo_id_key` (table_column_key). Spot-check this
-- against a real deployed Supabase project (e.g. `\d project_links` or
-- information_schema.table_constraints) before relying on this migration in production.
ALTER TABLE project_links DROP CONSTRAINT project_links_backend_repo_id_key;
ALTER TABLE project_links
  ADD CONSTRAINT project_links_backend_frontend_unique
  UNIQUE (backend_repo_id, frontend_repo_id);
