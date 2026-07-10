# Spec O — Multi-Frontend Fan-Out: DB Layer

**Wave:** V1 | **Agent:** module-builder | **Depends on:** V0 (migration `0005`)
**Files produced:** `src/lib/db/projectLinks.ts` (edit — additive only),
`tests/db/projectLinks.test.ts` (edit — new cases only, existing tests untouched)

## Purpose

Narrow, deliberately: this track is **only** the database-layer change needed for
multi-frontend fan-out. The pipeline restructure and verdict aggregation that consume
this new function are Track P's job (Wave V2, `docs/specs/P-pipeline-v2-integration.md`)
— kept separate so this track and Track M (which edits `formatComment.ts` in the same
parallel wave) never touch the same file. See `docs/PLAN_V2.md §4` for why: the product
decision is **one aggregated verdict per PR**, not one check run per frontend, so there
is no per-link naming/marker work for this track to do at all — `checks.ts` and
`comments.ts` are untouched by this entire v2 effort.

Migration `0005_multi_frontend.sql` (Spec V0) has already dropped the solo `UNIQUE` on
`project_links.backend_repo_id` and replaced it with a `(backend_repo_id,
frontend_repo_id)` composite unique constraint by the time this track's code runs — a
backend repo may now have more than one `project_links` row.

## File — `src/lib/db/projectLinks.ts` (edit)

Add one new export. Do **not** remove, rename, or change the behavior of the existing
`getProjectLinkByBackendRepoId` — Track P's pipeline restructure needs the plural form,
but nothing in this codebase is told to stop using the singular one as part of this
track (leave that call-site decision to Track P, which owns `processPullRequest.ts`).

```ts
/**
 * Look up ALL link rows for a backend repository (multi-frontend fan-out). Empty
 * array when the repo is not registered — same "no rows = not registered" contract
 * the singular lookup already has, just plural.
 *
 * @throws Error when the underlying query returns an error.
 */
export async function getProjectLinksByBackendRepoId(
  db: SupabaseClient,
  backendRepoId: number,
): Promise<ProjectLink[]>;
```

Implementation — mirror `getProjectLinkByBackendRepoId` exactly, minus the
single-row constraint:
1. `db.from('project_links').select('*').eq('backend_repo_id', backendRepoId)` — no
   `.maybeSingle()`, this returns an array.
2. `error` truthy → throw `new Error('project_links lookup failed: ' + error.message)`
   (identical message prefix to the existing function — Track P's error handling can
   treat both lookups uniformly if it ever needs to).
3. `data` null/undefined → return `[]` (defensive; Supabase's array-select should return
   `[]` itself, but never assume).
4. Map each row through the SAME default-application logic the singular function
   already uses (`openapi_file_path ?? 'openapi.json'`, `frontend_src_directory ??
   'src'`) — do not duplicate that logic as a copy-pasted block; extract it into a
   small private helper (`toProjectLink(row): ProjectLink`) and have BOTH the existing
   singular function and this new plural function call it. This is the one refactor
   this track is allowed to make to the existing function — a pure extraction, no
   behavior change (the existing acceptance tests for the singular function must all
   still pass unmodified after the extraction).
5. MONOREPO (Law 8) still applies per-row exactly as today — a row with
   `backend_repo_id === frontend_repo_id` is valid and must not be filtered out; with
   multi-frontend fan-out, a monorepo row can now coexist with additional
   cross-repo rows for the same backend (e.g. one row scans the backend PR's own head
   for a co-located admin UI, another row scans an entirely separate marketing-site
   repo) — no special-casing needed, each row is independent.

## Acceptance tests

Extend the existing mock-Supabase-chain test file (same fake `from().select().eq()`
pattern already used — for the plural path the chain ends at `.eq()` with no
`.maybeSingle()`, so the mock's `.eq()` must itself resolve to `{ data, error }`):
1. Two rows for the same `backend_repo_id` → both returned, each with defaults applied
   per row independently.
2. Zero rows → `[]` (not `null`, not an error).
3. `error: { message: 'boom' }` → throws containing `'boom'`.
4. One row with `openapi_file_path: null` → defaulted to `'openapi.json'` in the
   returned array (proves the shared `toProjectLink` helper is actually being used by
   the new function, not a re-copied divergent version).
5. Regression: every existing test for `getProjectLinkByBackendRepoId` still passes
   unmodified after the `toProjectLink` extraction (this is the acceptance bar for the
   refactor in implementation step 4 — the extraction must be behavior-preserving).
6. Monorepo row (`backend_repo_id === frontend_repo_id`) present alongside a
   cross-repo row for the same backend, both returned in the plural result.

## Forbidden

- Editing `src/lib/github/checks.ts` or `src/lib/github/comments.ts` — no per-link
  naming/marker work exists in this v2 design (aggregated-verdict decision, see
  Purpose).
- Editing `src/lib/pipeline/processPullRequest.ts`, `src/lib/report/verdict.ts`, or
  `src/lib/report/formatComment.ts` — all pipeline-consumption and aggregation logic
  belongs to Track P, not this track.
- Removing or changing the return type/behavior of the existing
  `getProjectLinkByBackendRepoId` beyond the internal `toProjectLink` extraction.
- Any change to `supabase/migrations/` — this track consumes migration `0005`
  (Spec V0), it does not author or alter it.
