# Spec V0 — v2 Scaffold: Types, Env, Migrations

**Wave:** V0 | **Agent:** module-builder | **Depends on:** v1 (complete on `main`)
**Files produced:** `src/types/contract.ts` (edit), `src/config/env.ts` (edit),
`supabase/migrations/0005_multi_frontend.sql`,
`tests/config/env.test.ts` (edit — new cases only, do not remove existing ones),
`tests/db/migrations.test.ts` (new, optional — see Acceptance tests)

**Post-authoring correction:** File 3 below (`0004_processed_deliveries.sql`) was
**never implemented** — Track N's idempotency design was twice-revised after this spec
was authored (`docs/PLAN_V2.md §3`) and the delivery-claim-table approach was rejected
as actively harmful (a claim committed before work is durably handed off has no safe
release path on failure, so it silently swallows the retries it exists to protect).
Track N ships with exactly one idempotency mechanism — `createInProgressCheckRun`
reusing an existing non-completed check run — and no migration at all. The `0004`
numbering gap is intentional and permanent; `0005_multi_frontend.sql` is the only
migration this wave actually produced. File 3's section is left below only as a record
of the rejected design.

## Purpose

The one sequential wave every v2 track (L, M, N, O, P) depends on: the single deliberate
re-open of the frozen `BreakingChange` type (CLAUDE.md Law 1 — see `docs/PLAN_V2.md §7`),
two new optional env loaders/vars, and the two SQL migrations Wave V1 tracks N and O
build against. Nothing here is IO logic — it is types, env parsing, and DDL only.

## File 1 — `src/types/contract.ts` (edit)

Add exactly one optional field to the existing `BreakingChange` interface. Do not touch
any other interface in this file.

```diff
 export interface BreakingChange {
   field: string;
   parent: string;
   change: ChangeKind;
   original?: string;
   updated?: string;
+  renamedTo?: string; // set only by diff/detectRenames.ts on an unambiguous same-type
+                       // rename match (Track M) — never set anywhere else
 }
```

Update the file's header comment to note this is now `FROZEN CONTRACT except for this one
additive v2 field (see docs/PLAN_V2.md §7)` — do not remove the original "FROZEN
CONTRACT" language, append to it.

## File 2 — `src/config/env.ts` (edit)

Two independent, additive changes. Neither is validated by the existing `loadEnv()`/`Env`
— follow the exact precedent `loadDashboardEnv()`/`DashboardEnv` already set (optional,
separately memoized, throws only when explicitly invoked, never required for the core
webhook pipeline to boot).

### 2a — extend `Env`/`loadEnv()` with two new bounded-integer fields (Tracks L, P)

```ts
export interface Env {
  // ...existing fields unchanged...
  maxRefResolutionDepth: number; // default 5
  maxFrontendLinksConcurrency: number; // default 3
}
```

Parse both with the existing `parsePositiveInt(raw, fallback)` helper — do not write a
new parser. New source env vars: `MAX_REF_RESOLUTION_DEPTH` (default 5),
`MAX_FRONTEND_LINKS_CONCURRENCY` (default 3). These are optional (not added to
`REQUIRED_STRING_VARS`) — a deployment that never sets them still boots with the
defaults, same as `SCAN_CONCURRENCY`/`MAX_SCAN_FILES` today.

### 2b — new `loadQueueEnv()` / `QueueEnv` (Track N)

Follow `loadDashboardEnv()`'s shape exactly: separate interface, separate required-vars
list, separate memo variable, separate exported function. Do **not** fold these into
`Env`/`loadEnv()` — a deployment that never configures a queue must keep working on the
`after()` path (Track N's opt-in design, `docs/PLAN_V2.md §3`).

```ts
export interface QueueEnv {
  qstashToken: string;
  qstashCurrentSigningKey: string;
  qstashNextSigningKey: string;
}

const REQUIRED_QUEUE_VARS = [
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
] as const;

let memoizedQueue: QueueEnv | undefined;

export function loadQueueEnv(source?: NodeJS.ProcessEnv): QueueEnv;

/** True iff every REQUIRED_QUEUE_VARS entry is a non-empty string — does not throw. */
export function isQueueConfigured(source?: NodeJS.ProcessEnv): boolean;
```

`loadQueueEnv` throws `Missing required env var: <NAME>` for any missing var, exactly
like `loadDashboardEnv`. `isQueueConfigured` is new (no `loadDashboardEnv` precedent
needed one, but Track N's `route.ts` amendment needs a non-throwing existence check to
decide which branch to take) — implement it as a plain `try { loadQueueEnv(source);
return true; } catch { return false; }`, reusing `loadQueueEnv`'s own validation rather
than duplicating the var-presence check.

## File 3 — `supabase/migrations/0004_processed_deliveries.sql` (REJECTED — not implemented, see note above)

```sql
-- Webhook-delivery idempotency (Track N). A queue (QStash) or GitHub's own webhook
-- redelivery can cause the same X-GitHub-Delivery to reach the pipeline twice; this
-- table lets the route claim a delivery exactly once before any pipeline work starts,
-- in BOTH the queued and the after() fallback path (docs/PLAN_V2.md §3, §8).
CREATE TABLE processed_deliveries (
    delivery_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## File 4 — `supabase/migrations/0005_multi_frontend.sql`

```sql
-- Multi-frontend fan-out (Track O). Drops the one-backend-repo-per-link constraint;
-- a backend repo may now link to more than one frontend repo. Uniqueness moves to the
-- (backend, frontend) pair so the same pair cannot be linked twice.
ALTER TABLE project_links DROP CONSTRAINT project_links_backend_repo_id_key;
ALTER TABLE project_links
  ADD CONSTRAINT project_links_backend_frontend_unique
  UNIQUE (backend_repo_id, frontend_repo_id);
```

Verify the constraint name `project_links_backend_repo_id_key` against
`0001_project_links.sql` before writing the `DROP CONSTRAINT` line (Postgres's default
auto-generated name for a column-level `UNIQUE` — if the actual deployed name differs,
use `\d project_links` output or the information_schema to find it; do not guess a name
that doesn't match what's actually deployed).

## Acceptance tests

`src/types/contract.ts` has no test file of its own (it's a pure type — TypeScript
compilation is the only check; confirm existing consumers still typecheck with the field
absent/present, no test file needed here).

`tests/config/env.test.ts` — add these cases alongside the existing ones (do not modify
or remove any existing test):
1. `loadEnv()` with no `MAX_REF_RESOLUTION_DEPTH`/`MAX_FRONTEND_LINKS_CONCURRENCY` set →
   defaults `5` and `3`.
2. `loadEnv()` with both set to valid positive integers → parsed values returned.
3. `loadEnv()` with an invalid value (e.g. `'-1'`, `'abc'`) for either → falls back to
   its default (same `parsePositiveInt` contract already tested for `SCAN_CONCURRENCY`).
4. `loadQueueEnv()` with all three `QSTASH_*` vars set → returns the typed object.
5. `loadQueueEnv()` missing any one of the three → throws `Missing required env var:
   <NAME>`.
6. `isQueueConfigured()` with all three set → `true`; with any missing → `false`; never
   throws in either case.
7. Memoization: two `loadQueueEnv()` calls with no `source` override return the same
   object reference; a call with an explicit `source` bypasses the memo (mirror the
   existing `loadDashboardEnv` memoization tests).

Migrations have no vitest coverage in this repo (v1 precedent — `0001`/`0002` are
untested SQL). Do not invent a test harness for SQL; a plain read-through by the
orchestrator's gate is sufficient. If useful, leave a one-line comment in the migration
file itself noting the constraint-name assumption so it's easy to spot-check against a
real Supabase project before Wave V1's Track O code depends on it.

## Forbidden

- Touching any field in `BreakingChange` other than adding `renamedTo`.
- Touching any other type in `src/types/` (`ProjectLink`, `PipelineInput`, `UsageMatch`,
  `Verdict`, `ScanReport`, `CheckConclusion` are all untouched — CLAUDE.md Law 1).
- Folding `QueueEnv` fields into `Env`/`loadEnv()`, or making any `QSTASH_*` var required
  for `loadEnv()` to succeed.
- Editing `0001_project_links.sql` or `0002_link_ownership.sql` — migrations are
  append-only; fix forward with a new numbered file, never edit a shipped one.
