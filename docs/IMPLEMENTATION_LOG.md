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

**ESLint setup** (`chore/add-eslint-config`, merged to `main`)
- Adds `eslint@^9` + `eslint-config-next@^16` as dev dependencies (explicitly authorized
  as an exception to CLAUDE.md Law 13's approved-dependency list; the config package's
  major version doesn't need to track the app's `next@^15` since it has no `next` peer
  dependency), a flat `eslint.config.mjs`, and a `lint` script.
- First two attempts didn't land (one interrupted by the user before committing, one hit
  a transient API connection error before creating its branch) — third attempt succeeded.
- 8 lint violations left deliberately unfixed (documented in the branch's commit/PR
  context): `any` casts in test fixtures/helpers where fixing risks breaking AST-scanner
  fixture assertions, plus two real-but-minor findings (`LinkManager.tsx` calling
  setState synchronously in a `useEffect`, `layout.tsx` using `<a>` instead of
  `next/link` for internal navigation) left for a deliberate follow-up rather than a
  reflexive fix.
- `npm run lint` is NOT wired into `.github/workflows/ci.yml` — it would fail CI
  immediately given the 8 known violations. Follow-up decision needed: fix the
  remaining violations and then gate CI on lint, or leave lint local-only for now.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`.

**Fix: ESLint scanning stray worktree directories** (`fix/eslint-ignore-worktrees`, merged to `main`)
- Discovered while re-verifying locally: `eslint.config.mjs` had no `ignores` entry for
  `.claude/worktrees/`, so `npm run lint` was scanning every git worktree sitting under
  that path — including one from an unrelated, separately-locked session
  (`chore+finish-v1-gaps`, branch `feat/element-access-scanning`), which inflated the
  violation count from 8 to 18 with duplicate/irrelevant findings. That worktree was not
  touched.
- Added `{ ignores: [".claude/**"] }` to `eslint.config.mjs`; also committed a
  `package-lock.json` sync from running `npm install` locally (harmless optional-dependency
  resolution churn).
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Re-verified on
  `main`: `npm run typecheck` clean, `npm run lint` back to the expected 8 problems,
  `npm test` 24/24 files, 177/177 tests passing.
