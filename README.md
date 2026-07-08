# Guardrail

> Automated API contract enforcement across repositories. Guardrail intercepts backend
> PRs that alter an OpenAPI spec, diffs the contract for deleted/type-mutated fields,
> AST-scans the linked frontend repo for live usage, and blocks the merge via the GitHub
> Checks API — with exact file/line locations — when the change would break the UI.

**Status:** core pipeline complete and fully tested (127 tests green). Not yet wired to a
live GitHub App / Supabase project — see [Deployment](#deployment).

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
  config/       env.ts — the only place that reads process.env
  lib/
    crypto/     verifySignature.ts        — HMAC-SHA256 webhook validation
    diff/       parseSpec, flattenSchema, diffSchemas — pure contract diffing
    scan/       concurrency, astScanner (pure) + scanRepo (IO orchestration)
    db/         supabase, projectLinks    — project_links lookups
    github/     client, contents, checks, comments — Octokit adapters
    report/     verdict, formatComment    — verdict matrix + PR markdown
    pipeline/   processPullRequest.ts     — the only module that glues it all
  app/api/webhook/github/route.ts         — verify → 202 → after()
supabase/migrations/                      — project_links DDL
tests/                                    — mirrors src/ (127 tests)
docs/                                     — architecture plan & per-module specs
```

## Getting started

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 127 tests
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

## Documentation

- [CLAUDE.md](CLAUDE.md) — the architecture laws every contributor (human or agent) follows
- [docs/PLAN.md](docs/PLAN.md) — implementation plan: dependency graph, module contracts, build waves
- [docs/specs/](docs/specs/) — per-module specifications (public APIs, algorithms, acceptance tests)

## License

TBD
