# Guardrail — Master Implementation Plan

Source of truth: `System Requirements Document: Guardrail` (SRD). This plan decomposes the
system into single-responsibility files, groups them into parallel-safe tracks, and defines
the orchestration loops that let multiple subagents build the system concurrently without
stepping on each other.

**Status:** v1 complete — every track (W0, A–J) plus the Wave 4 dashboard (Spec K, see §7)
is implemented, with 180 tests green and `typecheck`/`lint` clean on `main`. This document
remains the build plan/reference; see `docs/IMPLEMENTATION_LOG.md` for the change-by-change
record of what actually shipped. v2 (the four §7 backlog items) is implemented on branch
`feat/v2` — 260 tests green, spec-audited with zero code defects — but **not yet merged to
`main`** pending one manual live-verification step; see `docs/PLAN_V2.md`'s Status line for
what's outstanding before that merge.

## 1. System summary

```
[Backend Repo PR] ──> (GitHub Webhook) ──> [Next.js Route Receiver /api/webhook/github]
                                                    │  verify HMAC · ack 202 · after()
                                                    ▼
                     [pipeline/processPullRequest]  ← the only orchestrator
                       │ 1. project_links lookup (Supabase)        db/
                       │ 2. create check run "in_progress"         github/checks
                       │ 3. fetch old+new OpenAPI spec             github/contents
                       │ 4. diff → BreakingChange[]                diff/
                       │ 5. list + fetch frontend files (bounded)  scan/scanRepo + concurrency
                       │ 6. AST scan → UsageMatch[]                scan/astScanner
                       │ 7. verdict matrix → Verdict               report/verdict
                       │ 8. comment (if warranted)                 github/comments + report/formatComment
                       └ 9. conclude check run                     github/checks
```

### Verdict matrix (SRD §4 — implement EXACTLY)

| Condition | Check conclusion | Action |
|---|---|---|
| 0 breaking changes | `success` | Pass. No comment. |
| changes > 0, 0 frontend references | `success` | Pass + comment logging unreferenced updates. |
| changes > 0, references > 0 | `failure` | Block + comment with per-file `path:line` locations. |
| Guardrail internal error (policy) | `neutral` | Fail-open, error summary (CLAUDE.md Law 10). |

### Non-negotiable edge cases (SRD §3)

1. **Destructuring aliases** — match source property key, never the alias (Law 6).
2. **Monorepo** — `backend_repo_id === frontend_repo_id` is legal; scope by
   `frontend_src_directory` prefix (Law 8).
3. **API timeout windows** — bounded concurrent fetching, single recursive tree call (Laws 9, 11).

## 2. File inventory & dependency graph

Every file below is single-responsibility. An arrow means "imports from".

```
Wave 0 (sequential, one agent)
  W0  package.json, tsconfig.json, vitest.config.ts, next.config.ts,
      .env.example, supabase/migrations/0001_project_links.sql,
      src/types/{contract,github,db}.ts, src/config/env.ts

Wave 1 (6 parallel tracks — depend ONLY on Wave 0 types)
  A   src/lib/crypto/verifySignature.ts
  B   src/lib/diff/parseSpec.ts ─> flattenSchema.ts ─> diffSchemas.ts   (one agent, in order)
  C   src/lib/scan/concurrency.ts, src/lib/scan/astScanner.ts           (one agent)
  D   src/lib/db/supabase.ts ─> projectLinks.ts                         (one agent)
  E   src/lib/github/client.ts ─> {contents,checks,comments}.ts         (one agent)
  F   src/lib/report/verdict.ts, formatComment.ts                       (one agent)

Wave 2 (3 parallel tracks — signatures frozen by specs, so parallel-safe; global gate at wave end)
  G   src/lib/scan/scanRepo.ts          (uses C + E)
  H   src/lib/pipeline/processPullRequest.ts   (uses B,C,D,E,F,G via injected deps)
  I   src/app/api/webhook/github/route.ts      (uses A + H + env)

Wave 3 (verification loop)
  J   tests/integration/pipeline.e2e.test.ts + shared fixtures + audit loop
```

Track independence proof: no Wave-1 track imports another Wave-1 track; all shared shapes
live in `src/types/` (frozen in Wave 0). Wave-2 files reference each other only through
signatures pre-declared in the specs, so they can be authored in parallel and compile-gated
together at wave end (Law 12).

## 3. Track → spec → agent assignment

| Track | Spec file | Files produced | Agent | Parallel with |
|---|---|---|---|---|
| W0 | `docs/specs/W0-scaffold-and-types.md` | scaffold + types + env + SQL | `module-builder` | — (must finish first) |
| A | `docs/specs/A-verify-signature.md` | verifySignature.ts | `module-builder` | B C D E F |
| B | `docs/specs/B-contract-diff.md` | parseSpec, flattenSchema, diffSchemas | `module-builder` | A C D E F |
| C | `docs/specs/C-ast-scan.md` | concurrency.ts, astScanner.ts | `ast-specialist` | A B D E F |
| D | `docs/specs/D-database.md` | supabase.ts, projectLinks.ts | `module-builder` | A B C E F |
| E | `docs/specs/E-github-adapters.md` | client, contents, checks, comments | `module-builder` | A B C D F |
| F | `docs/specs/F-report.md` | verdict.ts, formatComment.ts | `module-builder` | A B C D E |
| G | `docs/specs/G-scan-repo.md` | scanRepo.ts | `module-builder` | H I |
| H | `docs/specs/H-pipeline.md` | processPullRequest.ts | `module-builder` | G I |
| I | `docs/specs/I-webhook-route.md` | route.ts | `module-builder` | G H |
| J | `docs/specs/J-verification.md` | e2e test + fixtures | `module-builder` then `spec-auditor` | — |

## 4. Orchestration protocol (the loops)

The main session (orchestrator) executes this. Subagents never spawn subagents.

```
WAVE LOOP — for wave in [W0, W1, W2]:
  1. Spawn one agent per track in the wave (W1: 6 in parallel; W2: 3 in parallel).
     Prompt template (verbatim):
       "You are implementing track <X> of Guardrail. Read CLAUDE.md, then
        docs/PLAN.md §for your track, then docs/specs/<X>-*.md. Implement exactly
        that spec, including its acceptance tests. Report: files written, test
        results, any spec ambiguity you hit (do NOT resolve ambiguities yourself)."
  2. Wait for all agents in the wave.
  3. GATE: run `npm run typecheck` && `npm test` (full suite).
  4. If the gate fails: identify owning track(s) from the error paths, respawn
     that track's agent with the error output appended. Max 2 repair rounds per
     wave; if still red, STOP and escalate to the human.

AUDIT LOOP — after Wave 2 gate is green (this is Wave 3):
  1. Implement docs/specs/J-verification.md (integration fixtures + e2e test).
  2. Spawn `spec-auditor` with: "Audit every file in src/ against its spec in
     docs/specs/ and against CLAUDE.md laws. Report violations as
     file:line — law/spec clause — defect — suggested fix."
  3. If findings > 0: dispatch each finding to `module-builder` (batched per track),
     then GOTO 2. Max 3 audit rounds.
  4. Exit when: findings == 0 AND typecheck green AND full vitest green.
```

### Gate commands

```bash
npm run typecheck && npm test
```

Both must be green to close a wave. The orchestrator — not the wave agents — owns these
global gates (Law 12).

## 5. Shared type contracts (authored in W0, frozen thereafter)

Declared here so every track can read its dependencies' shapes without reading their code.

```ts
// src/types/contract.ts
export type ChangeKind = 'DELETED' | 'TYPE_MUTATED';
export interface BreakingChange {
  field: string;            // "phoneNumber"
  parent: string;           // "User" | "User.address" | "POST /users request"
  change: ChangeKind;
  original?: string;        // TYPE_MUTATED only, e.g. "integer"
  updated?: string;         // TYPE_MUTATED only, e.g. "string"
}
export interface UsageMatch {
  field: string;
  filePath: string;         // repo-relative, forward slashes
  line: number;             // 1-based
  column: number;           // 1-based
  kind: 'property-access' | 'destructuring';
  snippet: string;          // trimmed source line, max 200 chars
}
export type CheckConclusion = 'success' | 'failure' | 'neutral';
export interface Verdict {
  conclusion: CheckConclusion;
  title: string;            // <= 120 chars
  summary: string;          // markdown; caller truncates via truncateForChecks
  shouldComment: boolean;
}
export interface ScanReport {
  matches: UsageMatch[];
  scannedFileCount: number;
  truncated: boolean;       // tree truncated OR MAX_SCAN_FILES cap hit
}

// src/types/db.ts
export interface ProjectLink {
  id: string;
  backend_repo_id: number;
  frontend_repo_id: number;
  openapi_file_path: string;      // default 'openapi.json'
  frontend_src_directory: string; // default 'src'
  created_at: string;
}

// src/types/github.ts  (minimal hand-rolled webhook shapes — no @octokit/webhooks-types)
export interface PullRequestWebhookPayload {
  action: string;                          // we act on 'opened' | 'synchronize'
  installation?: { id: number };
  repository: { id: number; name: string; owner: { login: string }; full_name: string };
  pull_request: {
    number: number;
    head: { sha: string; ref: string };
    base: { ref: string };
  };
}
export interface PipelineInput {
  installationId: number;
  backendRepoId: number;
  backendOwner: string;
  backendRepo: string;
  prNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
}
```

## 6. Risk register (why the laws exist)

| Risk | Mitigation | Law |
|---|---|---|
| PAT cannot create check runs (403) | GitHub App installation auth only | 3 |
| Signature computed on re-serialized JSON never matches | raw `req.text()` first | 4 |
| Serverless kills post-response work | `after()` from next/server | 5 |
| Alias `{x: y}` matched on alias | propertyName-first rule | 6 |
| Monorepo rejected by mapper | non-unique frontend_repo_id + prefix scoping | 8 |
| Timeout on 1000s of files | 1 tree call + bounded blob fetches | 9, 11 |
| >1MB frontend file truncated | Blobs API, not Contents | 11 |
| Checks 422 on huge summary | truncateForChecks (65,535) | 15 |
| Guardrail bug freezes team merges | fail-open `neutral` | 10 |
| Parallel agents drift on shapes | frozen `src/types/` authored first | 1 |

## 7. Out of scope for v1 (do NOT build)

- OAuth onboarding UI / dashboard (project_links rows are inserted manually via SQL).
  → **Superseded in Wave 4:** the dashboard is now specified in
  `docs/specs/K-onboarding-dashboard.md` (public GitHub App: sign in with GitHub, pick
  repos from your installations, manage links in a UI). The rest of §7 still holds.
- `$ref` resolution across files or URLs (local `#/components/schemas/*` only).
- Renamed-field detection (a rename = DELETED + unrelated addition).
- Retries/queues beyond `after()` (no QStash/SQS in v1).
- Multi-frontend fan-out (one frontend repo per backend repo).
