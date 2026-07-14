# Guardrail — Agent Constitution

Guardrail intercepts backend PRs that change an OpenAPI spec, diffs the contract,
AST-scans the linked frontend repo for usage of deleted/type-mutated fields, and
passes/fails the PR via the GitHub Checks API.

**Read order for every agent, before writing any code:**
1. This file (the laws — non-negotiable).
2. `docs/PLAN.md` (waves, dependency graph, your place in it).
3. Your assigned spec in `docs/specs/` (exact file contract). Implement ONLY that spec.

Conflict resolution: CLAUDE.md laws > spec > your own judgment. Never improvise
public APIs — if a signature in a spec seems wrong, STOP and report; do not "fix" it.

## Commands

```bash
npm run typecheck   # tsc --noEmit  — must pass before you report done
npm test            # vitest run    — Wave 0-1 agents run the full suite
npx vitest run tests/<your-area>   # Wave 2 agents run ONLY their own tests (see Law 12)
```

## Repository map

```
src/types/        Frozen shared contracts (Law 1). contract.ts, github.ts, db.ts
src/config/       env.ts — typed, validated env access (only place touching process.env)
src/lib/crypto/   verifySignature.ts — HMAC-SHA256 webhook validation
src/lib/diff/     parseSpec.ts, flattenSchema.ts, diffSchemas.ts — pure contract diffing
src/lib/scan/     concurrency.ts, astScanner.ts (pure), scanRepo.ts (IO orchestration)
src/lib/db/       supabase.ts, projectLinks.ts — project_links lookups; linkAdmin.ts —
                  dashboard-only link CRUD (Spec K)
src/lib/github/   client.ts, contents.ts, checks.ts, comments.ts — Octokit adapters;
                  userRepos.ts — dashboard-only user-token adapter listing repos the
                  signed-in user can reach through an App installation (Spec K)
src/lib/report/   verdict.ts, formatComment.ts — pure verdict matrix + markdown
src/lib/auth/     session.ts (seal/unseal an encrypted session cookie), oauth.ts
                  (GitHub OAuth code exchange), authorize.ts (pure authorization law for
                  linking a repo) — dashboard sign-in (Spec K)
src/lib/pipeline/ processPullRequest.ts — the only module allowed to glue everything
src/app/api/webhook/github/route.ts — Next.js route: verify → 202 → after()
src/app/api/auth/     login/, callback/, logout/route.ts — GitHub OAuth login kickoff,
                       callback, and session logout (Spec K)
src/app/api/dashboard/ repos/route.ts — accessible-repo listing for the dashboard UI (Spec K)
src/app/api/links/    route.ts — link CRUD (GET/POST/DELETE); every mutation re-authorizes
                       server-side against a fresh fetch of the caller's accessible repos
                       (Spec K)
src/app/api/_lib/     requireSession.ts — shared session/CSRF/dependency-construction
                       helpers for the routes above; `_` prefix opts it out of Next.js
                       routing (not a route file)
src/app/dashboard/    page.tsx (server component: resolves the session, redirects if
                       signed out) + LinkManager.tsx (client UI for viewing/creating/
                       deleting links) (Spec K)
tests/            Mirrors src/. Fixtures in tests/fixtures/
supabase/migrations/  SQL DDL
```

## The Laws

1. **Types are frozen.** All shared interfaces live in `src/types/` (written in Wave 0).
   Import them; NEVER redefine, extend, or edit them. Local helper types are fine.
2. **Pure core, IO shell.** `diff/`, `report/`, `scan/astScanner.ts`, `scan/concurrency.ts`,
   `crypto/` must not import Octokit, Supabase, `next/*`, or read env. IO lives only in
   `github/`, `db/`, `scan/scanRepo.ts`, `pipeline/`, `app/`.
3. **Checks API needs GitHub App auth.** A PAT cannot create check runs. Always
   authenticate as the App installation using `installation.id` from the webhook payload
   (`src/lib/github/client.ts` is the only factory).
4. **HMAC over the raw body.** The route reads `await req.text()` BEFORE JSON.parse and
   verifies `X-Hub-Signature-256` with `crypto.timingSafeEqual`. Never string `===`,
   never re-serialize the payload, never log the secret.
5. **Ack 202, then work.** The route responds within milliseconds and defers the pipeline
   with `after()` from `next/server`. No awaiting the pipeline before responding.
6. **Alias rule (AST).** For `const { phoneNumber: phone } = u`, match the SOURCE property
   key (`propertyName` if present, else `name`) — never the alias. Computed keys,
   array-binding elements, and rest elements are skipped.
7. **No regex scanning.** Field usage detection uses the `typescript` compiler API only
   (`PropertyAccessExpression`, `BindingElement`). Regex on source text is forbidden.
8. **Monorepo rule.** `backend_repo_id` may equal `frontend_repo_id` (only the backend
   column is UNIQUE). All frontend file selection is scoped by `frontend_src_directory`
   prefix in exactly one place: `scanRepo.ts`.
9. **Bounded concurrency.** All bulk file fetches go through
   `mapWithConcurrency(items, limit, worker)` — default limit from env (8). Never
   `Promise.all` over an unbounded file list; never fetch sequentially.
10. **Fail-open.** Unexpected pipeline errors conclude the check run as `neutral` with an
    error summary — never `failure`, never a hanging `in_progress`. Guardrail's own bugs
    must not block merges.
11. **Blobs, not Contents, for source files.** File listing = one
    `git/trees/{ref}?recursive=1` call; file bodies = Git Blobs API (base64 → utf8).
    (Contents API caps at 1 MB.) The Contents API is used only for the two OpenAPI spec
    fetches.
12. **Scoped verification in Wave 2.** Wave-2 files import sibling Wave-2 files that may
    not exist yet mid-wave; run only your own test file. The orchestrator runs global
    `typecheck` + full `vitest` as the wave gate.
13. **Approved dependencies only** (see below). Adding any other package requires stopping
    and reporting. No lodash, no axios, no p-limit (Law 9 is hand-rolled).
14. **Line/column numbers are 1-based** everywhere they cross a module boundary or reach
    GitHub output.
15. **Checks output caps.** `output.summary` max 65,535 chars — always pass report text
    through `truncateForChecks()` before the API call.
16. **Branch per change.** NEVER commit directly to `main`. Every change — however small —
    happens on its own branch named `<type>/<short-kebab-description>`, where `<type>` is a
    Conventional-Commits prefix: `feat` (new capability), `fix` (bug fix; use this, not
    `bug`), `docs`, `refactor`, `test`, `chore` (tooling/process), or `perf`. Workflow,
    every time: branch off `main` → edit → commit (message prefixed with the same
    `<type>:`) → merge back into `main` with `--no-ff` → delete the branch → push `main`.
    One branch per logical edit — never batch unrelated changes onto one branch, and never
    leave `main` with uncommitted work before branching.

## Approved dependencies

Runtime: `next@^15`, `react@^19`, `react-dom@^19`, `typescript@^5` (runtime dep — the
scanner uses it), `yaml@^2`, `octokit@^4`, `@supabase/supabase-js@^2`.
Dev: `vitest@^3`, `@types/node@^22`, `@types/react@^19` (type companion required for the
React/Next typed build; no runtime footprint), `eslint@^9`, `eslint-config-next@^16`
(flat-config lint setup; `npm run lint`), `@vitest/coverage-v8@^3`, `jsdom`,
`@testing-library/react@^16` (test-only; user-approved 2026-07-14).
Node built-ins (`node:crypto`, `node:buffer`) are always allowed.

## Environment variables (accessed only via `src/config/env.ts`)

`GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (\n-escaped; env.ts
un-escapes), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SCAN_CONCURRENCY` (default 8),
`MAX_SCAN_FILES` (default 2000). These seven are validated by `loadEnv()` / the `Env`
interface and are required for the core webhook pipeline.

Five more variables power the **optional** public onboarding dashboard (Spec K) only —
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`,
`GUARDRAIL_SESSION_SECRET` (must be >= 32 characters — `loadDashboardEnv()` throws
otherwise), `APP_BASE_URL` (trailing slash stripped at load). They are validated
separately by `loadDashboardEnv()` / the `DashboardEnv` interface in `src/config/env.ts`,
NOT by `loadEnv()` — the webhook pipeline works on deployments that never set any of them.

## Local machine notes

- Windows; the repo path contains a space — always quote paths in shell commands.
- The project is named "Guardrail" (remote: dheeraj-droid/Guardrail); the local folder is
  spelled "GaurdRail" — use "Guardrail" in code/docs, never assume the folder name.
- `.env` files are gitignored except `.env.example`; put secret placeholders there.
- `gh` CLI is installed but not on PATH: invoke as `& "C:\Program Files\GitHub CLI\gh.exe" ...`.
- Use `npm` (no yarn/pnpm).

## Definition of done (every agent, every spec)

- Every export in the spec's "Public API" exists with the exact signature.
- All "Acceptance tests" from the spec are written and green.
- `npm run typecheck` passes (Wave 0-1) or your scoped test passes (Wave 2).
- No `console.log` outside `pipeline/` and `route.ts` (use the spec's logging rules).
- You touched ONLY the files your spec names (plus your own test files).
