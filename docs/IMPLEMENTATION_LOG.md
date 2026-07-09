# Implementation Log

Running record of implementation work: what changed, where, and the outcome. Append an
entry per logical change (matches the Law 16 branch-per-change granularity) — this is a
record of what happened, not a plan.

## 2026-07-09

**CI workflow** (`chore/add-ci-workflow`, merged to `main`)
- Added `.github/workflows/ci.yml`: runs `npm ci`, `npm run typecheck`, `npm test` on
  push to `main` and on every pull request.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`.

**Docs sync** (`docs/sync-dashboard-docs`, merged to `main`)
- Updated CLAUDE.md's "Repository map" to cover the Spec K dashboard/auth surface
  (`src/lib/auth/`, `src/app/api/auth/`, `src/app/api/dashboard/`, `src/app/api/links/`,
  `src/app/api/_lib/`, `src/app/dashboard/`) and "Environment variables" to document the
  5 dashboard-only vars (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_SLUG`, `GUARDRAIL_SESSION_SECRET`, `APP_BASE_URL`).
- Updated README.md's stale "160 tests" claim to the verified actual count (177).
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Verified with
  `npm run typecheck` (clean) and `npm test` (24 files / 177 tests passing) after merge.

**ESLint setup** (`chore/add-eslint-config`) — in progress
- Adds `eslint` + `eslint-config-next` as dev dependencies (explicitly authorized as an
  exception to CLAUDE.md Law 13's approved-dependency list), a flat `eslint.config.mjs`,
  and a `lint` script.
- First two attempts didn't land (one interrupted by the user before committing, one hit
  a transient API connection error before creating its branch) — retried.
- Outcome: pending.
