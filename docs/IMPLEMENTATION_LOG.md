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

**Bracket-notation field scanning** (`feat/element-access-scanning`, merged to `main`)
- Closed a documented v1 false-negative gap (`PLAN.md §7`, `docs/specs/C-ast-scan.md`
  "Forbidden"): `astScanner.ts` previously only matched dot-access
  (`PropertyAccessExpression`) and destructuring (`BindingElement`), so
  `user["phoneNumber"]` shipped undetected — a deleted/type-mutated field used via
  bracket notation would silently pass the check.
- Added a third checkpoint: `ts.isElementAccessExpression(node)` with a string-literal
  `argumentExpression`, recorded with the existing `kind: 'property-access'` (no change to
  the frozen `UsageMatch` type — Law 1). Dynamic keys (`user[key]`) stay untracked, same
  as before.
- Added 3 acceptance tests (bracket literal match, dynamic-key skip, multi-hit columns);
  updated `docs/specs/C-ast-scan.md` and `docs/PLAN.md §7` to reflect the new checkpoint
  instead of listing it as out-of-scope/forbidden.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Verified with
  `npm run typecheck` (clean) and `npm test` (24 files / 180 tests passing).
