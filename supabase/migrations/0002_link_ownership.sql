-- Dashboard ownership metadata (Spec K). Nullable on purpose: rows inserted manually
-- (v1 era) remain valid; the pipeline's frozen ProjectLink type does not know these
-- columns and must not need to.
ALTER TABLE project_links
  ADD COLUMN IF NOT EXISTS created_by_github_id BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_login VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
