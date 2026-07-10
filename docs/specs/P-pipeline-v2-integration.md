# Spec P — Pipeline v2 Integration (Wave V2 glue)

**Wave:** V2 | **Agent:** module-builder | **Depends on:** L, M, N, O (all of Wave V1,
merged) — this is a SEQUENTIAL wave, do not start until V1's gate is green
**Files produced:** `src/lib/pipeline/processPullRequest.ts` (rewrite),
`src/lib/report/aggregateVerdicts.ts` (new), `src/lib/report/formatComment.ts` (edit —
on top of Track M's already-merged rename-messaging edit),
`tests/pipeline/processPullRequest.test.ts` (edit — new multi-link/ref-resolution
cases, ALL existing single-link cases must still pass unmodified),
`tests/report/aggregateVerdicts.test.ts` (new),
`tests/report/formatComment.test.ts` (edit — new multi-link cases)

## Purpose

The single wave that wires together everything Wave V1 built in isolation: Track L's
`resolveSpecRefs` (ahead of diffing), Track O's `getProjectLinksByBackendRepoId` (plural
links), and a new aggregation layer that turns N independent per-link evaluations into
**one** check run and **one** comment per PR (the aggregated-verdict decision,
`docs/PLAN_V2.md §4`). Track M's `diffSchemas.ts`/`formatComment.ts` changes are
transparent to this wave (same function signatures, richer output) and Track N's queue
is entirely upstream of the pipeline — neither needs a code change here.

**The single-link case must be byte-identical to what's on `main` today.** Every
existing acceptance test in `tests/pipeline/processPullRequest.test.ts` and
`tests/report/formatComment.test.ts` must pass completely unmodified after this
rewrite — the exact same check-run conclusion/title/summary and the exact same comment
body for a backend repo with exactly one `project_links` row. This is the regression
safety net; do not treat any existing test as needing an update to "fit" the new code —
if a test seems to need changing, the design is wrong, not the test.

## Design: `LinkOutcome` — the unifying shape

Today's `processPullRequest.ts` handles six distinct outcomes per link inline (five
early-return special cases plus the full evaluate-and-conclude path). Reify all six as
one discriminated union so a single aggregation function can reason about any mix of
them:

```ts
export type LinkOutcome =
  | {
      kind: 'evaluated';
      link: ProjectLink;
      frontendRepoFullName: string;
      changes: BreakingChange[];
      scan: ScanReport;
      verdict: Verdict; // computeVerdict(changes, scan.matches) — UNCHANGED function
    }
  | { kind: 'no-spec'; link: ProjectLink }
  | { kind: 'spec-added'; link: ProjectLink }
  | { kind: 'spec-removed'; link: ProjectLink }
  | { kind: 'spec-unparseable'; link: ProjectLink; message: string }
  | { kind: 'frontend-unreachable'; link: ProjectLink }
  | { kind: 'internal-error'; link: ProjectLink; message: string };
```

Each non-`evaluated` kind corresponds EXACTLY to one of today's five early-return
branches in `processPullRequest.ts` (read the current file before writing the new one —
the branch conditions, in order, are: both specs missing → `no-spec`; only new exists →
`spec-added`; only old exists → `spec-removed`; a `SpecParseError` on either →
`spec-unparseable`; a 404/403 resolving the frontend repo id → `frontend-unreachable`)
plus one NEW kind, `internal-error`, covering what today's outer `catch` block handles —
reified per-link here because with multiple links, one link's unexpected error must not
abort evaluation of the others (Law 10 extended to link granularity, not just pipeline
granularity).

## File 1 — `src/lib/pipeline/processPullRequest.ts` (rewrite)

New top-level structure (`processPullRequest`'s exported signature —
`(deps: PipelineDeps, input: PipelineInput) => Promise<void>` — does NOT change; nothing
outside this file needs to know it now handles plural links):

```
1. links = await getProjectLinksByBackendRepoId(deps.db, backendRepoId)
   catch → logCaughtError, return (identical to today's step-1 failure handling)
2. links.length === 0 → log "not registered", return (IDENTICAL to today — unregistered
   repos see zero Guardrail surface, still true for the plural lookup)
3. octokit = await deps.getInstallationClient(...); checkRunId = await
   createInProgressCheckRun(...)   — UNCHANGED: one check run, opened before any link
   work, exactly as today. Failure here → logCaughtError, return (nothing to conclude
   yet, same as today).
4. outcomes = await mapWithConcurrency(links, deps.env.maxFrontendLinksConcurrency,
   link => evaluateLink(octokit, deps.env, backendOwner, backendRepo, backendRepoId,
   baseRef, headSha, link))
   — evaluateLink (private helper, see below) NEVER throws; every failure mode inside
   it resolves to a LinkOutcome variant instead. This is what makes step 4 safe to run
   under mapWithConcurrency, whose own doc comment (concurrency.ts) says it rejects on
   the FIRST worker error — safe here only because evaluateLink is required to swallow
   everything internally, exactly as today's whole function already does end-to-end.
5. verdict = aggregateVerdicts(outcomes)   — new pure function, see File 2. For
   links.length === 1 this MUST reduce to exactly today's single-link
   conclusion/title/summary (see File 2's degeneracy requirement).
6. if (verdict.shouldComment) await upsertPrComment(octokit, { owner: backendOwner,
   repo: backendRepo, prNumber, body: buildCommentBody(outcomes) })
   — buildCommentBody (File 3) branches on outcomes.length internally; for length 1 it
   calls the EXISTING formatPrComment unchanged.
7. await conclude(octokit, { ...checkRunId, conclusion: verdict.conclusion, title:
   verdict.title, summary: verdict.summary })   — conclude()'s own body (truncateForChecks
   application, logging) is UNCHANGED from today.
8. outer catch (steps 3-7): UNCHANGED shape from today's outer catch — logCaughtError,
   attempt to conclude 'neutral' with the "Guardrail internal error" message, catch a
   failing conclude too. This now only fires for a bug in orchestration itself (link
   resolution, check-run open/conclude, aggregation) — NOT for a single link's own
   failure, which evaluateLink already absorbs into a LinkOutcome.
```

### `evaluateLink` (private helper — replaces today's inline steps 4-9)

Same signature shape as the params list above; returns `Promise<LinkOutcome>`, never
rejects (wrap the ENTIRE body in try/catch; the catch produces `{ kind:
'internal-error', link, message }`). Body is today's steps 4-9 verbatim, with exactly
one addition and one output-shape change:

- **Addition (Track L wiring):** immediately after `oldSpec = parseOpenApiSpec(...)` /
  `newSpec = parseOpenApiSpec(...)` succeed, call
  `resolveSpecRefs(octokit, { owner: backendOwner, repo: backendRepo, ref: baseRef,
  rootSpec: oldSpec, rootPath: link.openapi_file_path, maxDepth:
  env.maxRefResolutionDepth, concurrency: env.scanConcurrency })` for the old spec and
  the equivalent call with `ref: headSha, rootSpec: newSpec` for the new spec, BEFORE
  calling `diffOpenApiSchemas(oldSpec, newSpec)`. `resolveSpecRefs` never throws (Spec
  L's contract) — no new try/catch needed around these two calls specifically.
- **Output-shape change:** instead of calling `conclude()`/`upsertPrComment()` directly
  at each branch point (today's behavior), each branch RETURNS the corresponding
  `LinkOutcome` variant. The zero-changes short-circuit (today's step 7: skip scanning
  entirely when `changes.length === 0`) is preserved exactly — it still avoids all
  frontend API calls, it just now returns `{ kind: 'evaluated', ..., verdict:
  computeVerdict([], []) }` instead of concluding inline.

## File 2 — `src/lib/report/aggregateVerdicts.ts` (new, PURE — Law 2)

```ts
import type { Verdict, CheckConclusion } from '@/types/contract';
import type { LinkOutcome } from '@/lib/pipeline/processPullRequest';

/**
 * Combine N per-link outcomes into ONE check-run verdict (docs/PLAN_V2.md §4).
 * DEGENERACY REQUIREMENT: outcomes.length === 1 MUST return exactly the same
 * {conclusion, title, summary, shouldComment} today's single-link
 * processPullRequest.ts would have produced for that one outcome — byte-identical
 * strings, not just equivalent conclusions. This is what makes the single-link path
 * a regression-safe subset of the multi-link path rather than a separate code path.
 */
export function aggregateVerdicts(outcomes: readonly LinkOutcome[]): Verdict;
```

Implementation:
1. `describe(outcome): { conclusion: CheckConclusion; title: string; summary: string;
   shouldComment: boolean }` — a private per-outcome mapper producing EXACTLY today's
   text for each non-`evaluated` kind (copy the title/summary strings verbatim from the
   current `processPullRequest.ts` — see Purpose section for the exact five strings to
   preserve character-for-character, parameterized by that link's own
   `openapi_file_path`/`frontend_repo_id`/error message) and, for `evaluated`, returns
   `outcome.verdict` directly (already exactly `computeVerdict`'s output).
   `shouldComment` is `false` for every non-`evaluated` kind (matches today — none of
   the five early-return branches ever call `upsertPrComment`) and `outcome.verdict.shouldComment`
   for `evaluated`.
2. `outcomes.length === 1` → `return describe(outcomes[0])` — nothing else runs. This
   single line IS the degeneracy guarantee; do not special-case individual fields
   elsewhere in a way that could diverge from this.
3. `outcomes.length > 1`:
   - `conclusion`: worst-wins priority `failure` > `neutral` > `success` across
     `outcomes.map(describe).map(d => d.conclusion)`.
   - `shouldComment`: `true` if ANY `describe(o).shouldComment` is `true`.
   - `title`: a short aggregate line, e.g. `` `${links.length} linked frontend(s) — ` +
     (conclusion === 'failure' ? 'breaking references found' : conclusion === 'neutral'
     ? 'some frontends could not be evaluated' : 'no breaking changes') `` — exact
     wording is this track's judgment call, keep it under the existing 120-char title
     cap (`Verdict.title` doc comment).
   - `summary`: concatenate one block per outcome, e.g. `` `### ${frontendLabel(o)}\n${
     describe(o).title}\n\n${describe(o).summary}\n\n` `` joined, where
     `frontendLabel(o)` is `o.link.frontend_repo_id === o.link.backend_repo_id ?
     '(monorepo)' : o.kind === 'evaluated' ? o.frontendRepoFullName : \`repo
     ${o.link.frontend_repo_id}\`` (frontend owner/name is only resolved on the
     `evaluated` path today — the other branches never look it up, so don't invent a
     new API call just to label them; fall back to the numeric id). The pipeline's
     existing `truncateForChecks` call (unchanged, still applied once by `conclude()`)
     handles length capping — this function does not need its own truncation.

## File 3 — `src/lib/report/formatComment.ts` (edit, on top of Track M's merged change)

Add ONE new exported function; do not restructure `formatPrComment` itself beyond what's
needed to share its section-building logic (extract, do not duplicate):

1. Extract the existing body of `formatPrComment` — everything between the
   `REPORT_MARKER`/header push and the footer push — into a private
   `buildSection(opts: { changes, scan, frontendRepoFullName, openapiFilePath }):
   string[]` (array of lines, matching the file's existing `lines: string[]` idiom).
   `formatPrComment` becomes: marker + header + `buildSection(opts)` + footer — same
   `.join('\n')` output as today, character-for-character (regression tested by the
   existing `formatComment.test.ts` suite, unmodified).
2. New export:
   ```ts
   export function formatAggregatePrComment(
     outcomes: readonly LinkOutcome[],
   ): string;
   ```
   - `outcomes.length === 1` → `return formatPrComment(...)` built from that one
     `evaluated` outcome's fields (this function is only ever called when
     `verdict.shouldComment` is true, and for a singleton that only happens on the
     `evaluated` kind — same reasoning as `aggregateVerdicts`'s degeneracy case).
   - `outcomes.length > 1` → `REPORT_MARKER` + `## Guardrail Contract Report` +  a
     summary table (`| Frontend | Status |` — one row per outcome, ALL outcomes, not
     just the ones with a detail section: `✅`/`❌`/`⚠️` + a short status phrase per
     `LinkOutcome.kind`) + then, for every `evaluated` outcome whose own
     `verdict.shouldComment` is `true`, a `### <frontendRepoFullName>` heading followed
     by `buildSection(...)` for that outcome (non-`evaluated` outcomes and
     zero-changes `evaluated` outcomes get ONLY their summary-table row, no detail
     section — there is nothing further to say) + one shared footer summing
     `scannedFileCount` across all `evaluated` outcomes and setting the truncation
     warning if ANY of them truncated.

## Acceptance tests

`aggregateVerdicts.test.ts`:
1. Singleton `evaluated` outcome with changes → output equals `outcome.verdict` exactly
   (fields compared, not just conclusion).
2. Singleton `no-spec` outcome → title/summary equal today's exact "OpenAPI spec not
   found" strings (copy-paste comparison against the current `processPullRequest.ts`
   source, not a paraphrase).
3. (Repeat #2's exact-string check for each of the other four non-evaluated kinds —
   `spec-added`, `spec-removed`, `spec-unparseable`, `frontend-unreachable`.)
4. Two outcomes, one `failure`-conclusion evaluated + one `success`-conclusion evaluated
   → aggregate `failure` (worst-wins).
5. Two outcomes, one `internal-error` (→ neutral) + one `success`-conclusion evaluated
   with zero changes → aggregate `neutral` (an error must not be silently dropped to
   `success` just because the other link was clean).
6. Two outcomes, one `internal-error` (→ neutral) + one `failure`-conclusion evaluated →
   aggregate `failure` (a real failure must not be diluted to `neutral` by a sibling
   error — worst-wins, `failure` beats `neutral`).
7. All outcomes `success`/non-evaluated-non-error → aggregate `success`.
8. `shouldComment` true iff at least one outcome is `evaluated` with `changes.length >
   0` — verify a mix where only a `spec-added` and a zero-changes `evaluated` outcome
   are present → `shouldComment: false` (nothing worth commenting, matches today's
   single-link behavior for either case alone).

`formatComment.test.ts` new cases:
1. `formatAggregatePrComment` with 2 outcomes (one failing, one clean) → summary table
   has 2 rows, exactly 1 detail section (the failing one).
2. `formatAggregatePrComment` with a singleton evaluated outcome → byte-identical to
   `formatPrComment` called directly with the same fields.
3. Non-evaluated outcome kinds (`spec-removed`, `internal-error`, etc.) appear in the
   summary table with an appropriate status phrase, never with a detail section.

`processPullRequest.test.ts` — ALL existing cases must pass unmodified (this is the
primary regression gate for this entire track), plus new cases:
1. Two links for one backend repo, one clean and one with a broken reference → ONE
   check run concludes `failure`; ONE comment posted with both frontends represented.
2. `resolveSpecRefs` is invoked (spy/fake) for both old and new spec before
   `diffOpenApiSchemas` runs, for every link.
3. One link throws an unexpected error inside `evaluateLink` (e.g. a fake `scanFrontendRepo`
   that rejects) while a second link evaluates cleanly → aggregate is `neutral` (not
   `success`, not a thrown/unhandled rejection propagating out of
   `processPullRequest`), and the clean link's own result is still reflected in the
   comment.
4. `MAX_FRONTEND_LINKS_CONCURRENCY` respected: with 3+ links and a concurrency of 1,
   assert no two `evaluateLink` invocations overlap (mirror whatever concurrency-assertion
   pattern the existing `scanRepo`/`concurrency` tests already use).

## Forbidden

- Changing `computeVerdict`'s signature or matrix (Spec F, untouched) — `aggregateVerdicts`
  wraps it, never replaces it.
- Changing `createInProgressCheckRun`/`concludeCheckRun`/`upsertPrComment` signatures —
  Track O's resolution (`docs/PLAN_V2.md §4`) means `checks.ts`/`comments.ts` need zero
  v2 changes; if this track finds itself wanting to add a parameter there, stop and
  reconsider the design instead (the aggregation is supposed to live entirely on the
  caller side).
- Any change to `tests/pipeline/processPullRequest.test.ts` that ALTERS an existing
  assertion rather than adding a new one — if an old assertion needs to change, that is
  a regression, not a valid edit.
- `Promise.all`/sequential-await over `links` — must route through `mapWithConcurrency`
  (Law 9, applied at this new link-fan-out granularity same as it already applies to
  file-fan-out inside `scanRepo.ts`).
