# Spec H — The Pipeline Orchestrator

**Wave:** 2 | **Agent:** module-builder | **Depends on:** every Wave-1 track + G
**Files produced:** `src/lib/pipeline/processPullRequest.ts`,
`tests/pipeline/processPullRequest.test.ts`
**Gate note (Law 12):** run only your own test file; the wave gate compiles everything.

## Purpose
The ONE module that glues gateway → diff → db → scan → report → GitHub (SRD §2 pipeline).
Everything is dependency-injected so the integration test (Track J) runs it with fakes.

## Public API (exact)
```ts
import type { Octokit } from 'octokit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';
import type { PipelineInput } from '@/types/github';

export interface PipelineDeps {
  env: Env;
  db: SupabaseClient;
  getInstallationClient(env: Env, installationId: number): Promise<Octokit>;
}
/** Never rejects: all failure modes are handled internally (Law 10). */
export async function processPullRequest(deps: PipelineDeps, input: PipelineInput): Promise<void>;
```

## Step-by-step control flow (implement in this order)

```
 1. link = getProjectLinkByBackendRepoId(deps.db, input.backendRepoId)
    └─ null → log `[guardrail] repo ${id} not registered — skipping` → RETURN (no check run:
       unregistered repos must see zero Guardrail surface).
 2. octokit = deps.getInstallationClient(deps.env, input.installationId)
 3. checkRunId = createInProgressCheckRun(octokit, { owner, repo, headSha: input.headSha })
    ── from here on, EVERY exit path must conclude this run (try/catch wraps 4–11).
 4. Fetch specs via fetchFileText (Contents API — the allowed use, Law 11):
      oldText = base:  { path: link.openapi_file_path, ref: input.baseRef }
      newText = head:  { path: link.openapi_file_path, ref: input.headSha }
    ├─ BOTH FileNotFoundError → conclude neutral, title `OpenAPI spec not found`,
    │   summary names the configured path → RETURN.
    ├─ old missing, new exists → spec is newly ADDED: no old contract to break →
    │   conclude success `New OpenAPI spec added` → RETURN.
    └─ old exists, new missing → spec DELETED in this PR: treat every old field as
        breaking? NO — v1 rule: conclude neutral, title `OpenAPI spec was removed`,
        summary asks the team to review manually. (Document with a comment.)
 5. oldSpec/newSpec = parseOpenApiSpec(...) — SpecParseError on EITHER →
    conclude neutral `OpenAPI spec unparseable` (fail-open, Law 10) → RETURN.
 6. changes = diffOpenApiSchemas(oldSpec, newSpec)
 7. changes.length === 0 → verdict = computeVerdict([], []) → conclude success → RETURN
    (SRD matrix row 1 — skip ALL frontend work; zero scan API calls).
 8. Resolve frontend repo coordinates:
    ├─ link.frontend_repo_id === input.backendRepoId (MONOREPO, Law 8):
    │    frontendOwner/Repo = input.backendOwner/backendRepo; scanRef = input.headSha
    │    (scan the PR's OWN head — the frontend code as it would be after merge).
    └─ else (cross-repo): repoInfo = octokit.request('GET /repositories/{id}',
         { id: link.frontend_repo_id }) → owner.login / name / default_branch;
         scanRef = default_branch (scan what is deployed-ish today).
         404/403 → conclude neutral `Frontend repository unreachable` → RETURN
         (the App installation must cover the frontend repo — document assumption).
 9. targetFields = new Set(changes.map(c => c.field))
    scan = scanFrontendRepo({ octokit, owner, repo, ref: scanRef,
             srcDirectory: link.frontend_src_directory,
             openapiFilePath: link.openapi_file_path, targetFields,
             concurrency: deps.env.scanConcurrency, maxFiles: deps.env.maxScanFiles })
10. verdict = computeVerdict(changes, scan.matches)
    if (verdict.shouldComment) upsertPrComment(octokit, { owner, repo,
        prNumber: input.prNumber,
        body: formatPrComment({ changes, scan, frontendRepoFullName, openapiFilePath }) })
11. concludeCheckRun(octokit, { ..., checkRunId, conclusion: verdict.conclusion,
        title: verdict.title, summary: verdict.summary })
CATCH (anything from 4–11):
    log the error with prefix `[guardrail]`; if checkRunId exists →
    concludeCheckRun(... neutral, title `Guardrail internal error`,
    summary `Guardrail hit an unexpected error and did not evaluate this PR. Merges are
    not blocked. Error: ${message}`) inside its OWN try/catch (a failing conclude must
    not crash the process). NEVER conclude failure from the catch block (Law 10).
```

## Logging rules
`console.log`/`console.error` allowed here (only here and route.ts). Every line prefixed
`[guardrail]`. Log: skip-unregistered, each conclude (conclusion+title), caught errors
(message + stack). NEVER log env values, spec contents, or tokens.

## Acceptance tests
Build `makeDeps()` returning: stub env; fake db (chainable, canned rows exactly as in
Track D tests); fake octokit `{ request: vi.fn() }` routing by URL string; and
`getInstallationClient` resolving that fake. Import real diff/scan/report modules —
only IO is faked (that is the point of the DI seam).
Fixtures: reuse `tests/fixtures/openapi/user-v1.json` / `user-v2.json` (Track B authored)
by reading them with `node:fs` in the test.
1. Unregistered repo → returns; zero octokit calls.
2. No schema changes (v1 vs v1) → conclude success; NO tree/blob calls; no comment.
3. Breaking changes + frontend references (blob returns source using `phoneNumber`) →
   conclude failure; comment body contains marker + `path:line`; check summary truncated-safe.
4. Breaking changes, no references → conclude success; comment posted ("safe to merge").
5. Spec missing on both refs → conclude neutral (`spec not found`).
6. New spec added (old 404, new exists) → conclude success.
7. Unparseable new spec → conclude neutral.
8. Monorepo row (ids equal) → scan hits the BACKEND repo at `input.headSha` (assert the
   tree call's owner/repo/ref) and never calls `GET /repositories/{id}`.
9. Cross-repo → `GET /repositories/{id}` resolved, tree call uses default_branch.
10. scanFrontendRepo throwing (make tree call reject) → conclude neutral with
    `Guardrail internal error`; promise resolves (never rejects).
11. Comment upsert failing → still concludes the check run (comment errors are caught
    by the same catch → neutral is acceptable v1 behavior; assert no unhandled rejection).

## Forbidden
- Direct `new Octokit`/`createClient` construction (deps only).
- Reading `process.env` (deps.env only).
- Concluding `failure` from any error path (Law 10 — failure is ONLY verdict row 3).
- Business logic that belongs to B/C/F (no inline diffing, matching, or markdown).
