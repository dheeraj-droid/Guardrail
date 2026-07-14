<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/guardrail-wordmark-dark.svg">
    <img src="docs/assets/guardrail-wordmark.svg" alt="Guardrail" height="72">
  </picture>
</p>

> Automated API contract enforcement across repositories. Guardrail intercepts backend
> PRs that alter an OpenAPI spec, diffs the contract for deleted/type-mutated fields,
> AST-scans the linked frontend repo for live usage, and blocks the merge via the GitHub
> Checks API — with exact file/line locations — when the change would break the UI.

**Status:** v1 + v2 both on `main` — core pipeline, the optional public onboarding
[dashboard](#dashboard), and v2 (cross-file `$ref` resolution, renamed-field detection,
an opt-in QStash retry queue, multi-frontend fan-out with one aggregated verdict per PR).
260 tests green across 30 files, `npm run typecheck` and `npm run lint` clean.
v1 is verified end-to-end against a live deployment ([guardrail-coral.vercel.app](https://guardrail-coral.vercel.app/))
with a real GitHub App and Supabase project: a PR deleting `phoneNumber` and mutating
`age` on [guardrail-demo](https://github.com/dheeraj-droid/guardrail-demo) produced a
correct `failure` check run with exact `file:line` locations, including through a
destructuring alias — see [Deployment](#deployment).

**v2's queue path (Track N) is also live-verified**, directly in production against the
same [guardrail-demo#1](https://github.com/dheeraj-droid/guardrail-demo/pull/1) test PR:
a real QStash publish/callback round-trip concluded a correct check run, and two
GitHub-triggered redeliveries of the same event were both fully evaluated rather than
silently dropped. See `docs/PLAN_V2.md`'s Status line and `docs/IMPLEMENTATION_LOG.md`'s
2026-07-13 entry for the full detail, including one nuance worth knowing before you rely
on it: check-run-level dedup only reuses a run that's still in progress, so a redelivery
arriving after completion (the common case — the pipeline finishes in ~2s) legitimately
produces its own additional check run rather than a duplicate-free single one; PR-comment
idempotency (one comment, updated in place) held throughout regardless.

## Why

A backend team deletes `phoneNumber` from the `User` schema. Tests pass, the PR merges,
and the frontend silently breaks in production because a component still reads
`user.phoneNumber`. Guardrail catches this **before merge**: it treats the OpenAPI spec as
a contract and fails the backend PR when a removed or type-changed field is still used in
the linked frontend.

## How it works

```
[Backend PR alters openapi.json]
          │  pull_request.opened / synchronize
          ▼
(GitHub Webhook)──▶ /api/webhook/github ──▶ verify HMAC ──▶ 202 Accepted
                                                │  after() defers the pipeline
                                                ▼
                          processPullRequest (the orchestrator)
   1. look up the backend↔frontend link            (Supabase: project_links)
   2. open an "in_progress" check run              (GitHub Checks API, App auth)
   3. fetch old + new openapi spec                 (Contents API, base vs head)
   4. diff the contract → BreakingChange[]         (deleted / type-mutated fields)
   5. list + fetch frontend source, bounded        (Git Trees + Blobs, concurrency-capped)
   6. AST-scan each file for the changed fields    (TypeScript compiler API — no regex)
   7. compute the verdict                          (SRD state machine)
   8. comment with exact path:line locations       (idempotent, one comment per PR)
   9. conclude the check run                        (success / failure / neutral)
```

### Verdict matrix

| Condition | Check result | PR action |
|---|---|---|
| No breaking schema changes | **success** | Pass — no comment |
| Changes found, **0** frontend references | **success** | Pass + comment logging the unreferenced updates |
| Changes found **and** referenced in frontend code | **failure** | Block merge + comment with line-by-line usage |
| Guardrail itself errors | **neutral** | Fail-open — never blocks a merge on our own bug |

## Design guarantees

Guardrail is built around a small set of non-negotiable invariants (the full list lives in
[CLAUDE.md](CLAUDE.md)). The load-bearing ones:

- **Fail-open.** Any unexpected error concludes the check run `neutral`, never `failure` —
  Guardrail's own bugs must not block a team's merges.
- **Constant-time webhook auth.** The `X-Hub-Signature-256` HMAC is verified over the raw
  request body with `timingSafeEqual`, before any JSON parsing.
- **Compiler-accurate scanning.** Field usage is detected via the TypeScript compiler API
  (`PropertyAccessExpression`, `BindingElement`) — never regex. Destructuring aliases
  (`const { phoneNumber: phone } = u`) match the *source* key, not the local alias.
- **Serverless-safe.** One recursive Git tree call + bounded-concurrency Blob fetches (not
  the 1 MB-capped Contents API), so large frontends don't blow the function timeout.
- **Monorepo-aware.** Backend and frontend may be the same repo; file selection is scoped
  by a source-directory prefix.

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript 5.7 · Octokit 4 · Supabase JS 2 · `yaml` 2
· Vitest 3. Node ≥ 20.

## Project layout

```
src/
  types/        Frozen shared contracts (contract.ts, github.ts, db.ts)
  config/       env.ts — process.env access (webhook `Env` + dashboard `DashboardEnv`)
  lib/
    crypto/     verifySignature.ts        — HMAC-SHA256 webhook validation
    diff/       parseSpec, flattenSchema, diffSchemas — pure contract diffing
    scan/       concurrency, astScanner (pure) + scanRepo (IO orchestration)
    db/         supabase, projectLinks, linkAdmin — project_links access
    github/     client, contents, checks, comments, userRepos — Octokit adapters
    report/     verdict, formatComment    — verdict matrix + PR markdown
    pipeline/   processPullRequest.ts     — the only module that glues it all
    auth/       session, oauth, authorize — dashboard sign-in + link authorization
  app/
    api/webhook/github/route.ts           — verify → 202 → after()
    api/auth/, api/dashboard/, api/links/ — dashboard sign-in + link CRUD routes
    page.tsx, dashboard/                  — landing page + link-manager UI
supabase/migrations/                      — project_links + dashboard-ownership DDL
tests/                                    — mirrors src/
docs/                                     — architecture plan & per-module specs
```

## Getting started

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 260 tests
npm run dev         # next dev (needs env vars configured, below)
```

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | Shared secret for `X-Hub-Signature-256` verification |
| `GITHUB_APP_ID` | GitHub App id (Checks API requires App, not PAT, auth) |
| `GITHUB_APP_PRIVATE_KEY` | App private key (`\n`-escaped; unescaped at load) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for `project_links` lookups |
| `SCAN_CONCURRENCY` | Max concurrent blob fetches (default 8) |
| `MAX_SCAN_FILES` | Cap on frontend files scanned per PR (default 2000) |

The webhook pipeline above needs only those seven (plus two optional, defaulted v2
tuning knobs: `MAX_REF_RESOLUTION_DEPTH` default 5, `MAX_FRONTEND_LINKS_CONCURRENCY`
default 3). Five more variables are read separately (`src/config/env.ts#loadDashboardEnv`)
and are only needed if you enable the [public dashboard](#dashboard):
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`,
`GUARDRAIL_SESSION_SECRET`, `APP_BASE_URL` — see
[docs/DEPLOY.md](docs/DEPLOY.md) Step 6. Three more (`QSTASH_TOKEN`,
`QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`) are read separately
(`src/config/env.ts#loadQueueEnv`) and only activate v2's durable retry queue
(`docs/specs/N-retry-queue.md`) — unset, the webhook falls back to `after()` exactly as
in v1.

## Deployment

**Full step-by-step runbook: [docs/DEPLOY.md](docs/DEPLOY.md)** (GitHub App setup, Supabase
seeding, Vercel deploy, end-to-end test, and a debugging table). In short, Guardrail needs
three things wired up before it can evaluate a real PR:

1. **A GitHub App** with Checks (read/write), Contents (read), and Pull requests
   (read/write) permissions, subscribed to `pull_request` events, its webhook pointed at
   `/api/webhook/github`. Install it on the backend and frontend repos.
2. **A Supabase database** — run `supabase/migrations/0001_project_links.sql`, then insert
   one row per backend↔frontend link:
   ```sql
   insert into project_links (backend_repo_id, frontend_repo_id, openapi_file_path, frontend_src_directory)
   values (123456789, 987654321, 'openapi.json', 'src');
   ```
   (Monorepo: set `frontend_repo_id` equal to `backend_repo_id`.)
3. **Env vars** from the table above, set in your host (e.g. Vercel).

## Dashboard

Guardrail also ships a small public onboarding dashboard so anyone can use it without SQL
or numeric repo IDs: install the GitHub App → sign in with GitHub → pick a backend and
frontend repo from your own installations → Guardrail creates/edits/deletes the
`project_links` row for you. It's entirely optional — the webhook pipeline works with or
without it, and a deployment that never sets the dashboard env vars just shows a
"not configured" note on the landing page instead of failing.

Security model, briefly (full detail in [docs/specs/K-onboarding-dashboard.md](docs/specs/K-onboarding-dashboard.md)):

- The signed-in user's GitHub token lives only in an AES-256-GCM-encrypted, HttpOnly,
  server-side session cookie (`src/lib/auth/session.ts`) — it is never sent to the
  browser in any other form and never logged.
- Every mutation (`POST`/`DELETE /api/links`) **re-fetches the caller's accessible repos
  from GitHub with their own session token** and re-runs the authorization law
  (`src/lib/auth/authorize.ts`) server-side — a client-supplied repo id is never trusted
  on its own. A repo is only linkable as a *backend* if the user has admin or maintain
  permission on it **and** the GitHub App is installed there.
- Mutating requests must carry a custom header (`x-guardrail-request: dashboard`), a
  same-site CSRF defense that cross-site requests cannot forge.
- The session and OAuth-state cookies use the `__Host-` name prefix, which browsers only
  accept when set with `Secure` over HTTPS. **Local dashboard dev over plain `http://`
  will not persist these cookies** — run the dev server with HTTPS
  (`next dev --experimental-https`) and open the app over `https://localhost` when working
  on sign-in locally. Deployed HTTPS environments are unaffected.

See [docs/DEPLOY.md](docs/DEPLOY.md) Step 6 to turn it on.

## Documentation

- [CLAUDE.md](CLAUDE.md) — the architecture laws every contributor (human or agent) follows
- [docs/PLAN.md](docs/PLAN.md) — implementation plan: dependency graph, module contracts, build waves
- [docs/specs/](docs/specs/) — per-module specifications (public APIs, algorithms, acceptance tests)

## License

TBD
