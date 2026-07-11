# Guardrail — v2 Implementation Plan

Companion to `docs/PLAN.md` (v1, complete and live-verified — see its Status line and
`docs/IMPLEMENTATION_LOG.md`). This document plans exactly the four items `PLAN.md §7`
listed as out-of-scope-for-v1, now scoped in for v2:

1. **$ref resolution** across files in the same repo (SRD gap: local `#/components/schemas/*`
   only today).
2. **Renamed-field detection** (today a rename reports as `DELETED` + an ignored addition).
3. **Retries/queues** beyond `after()` (no durable retry today if the process is killed
   mid-pipeline).
4. **Multi-frontend fan-out** (`project_links.backend_repo_id` is `UNIQUE` today — one
   frontend per backend, monorepo aside).

**Status:** specs authored — `docs/specs/V0-v2-types-env-migrations.md`,
`L-ref-resolution.md`, `M-rename-detection.md`, `N-retry-queue.md`,
`O-multi-frontend.md`, `P-pipeline-v2-integration.md` all exist at v1 spec fidelity, on
branch `feat/v2`. Track O's verdict-shape decision (§4) is resolved: one aggregated
check run/comment per PR, not one per frontend — this moved most of Track O's original
scope into the new Track P (Wave V2 pipeline integration) so it wouldn't collide with
Track M's parallel `formatComment.ts` edit. Implementation waves (V0 → V1 → V2 → V3) are
in progress; see `docs/IMPLEMENTATION_LOG.md` for wave-by-wave outcomes as they land.

## 0. Ground rules carried over from v1

Everything in `CLAUDE.md` still applies unmodified except where §8 below proposes a
narrow, explicit amendment. In particular: Law 1 (frozen types), Law 2 (pure core / IO
shell), Law 9 (bounded concurrency), Law 10 (fail-open), Law 13 (approved deps only), and
Law 16 (branch per change) all constrain every design decision made here.

## 1. Track L — $ref resolution

### Current gap

`flattenSchema.ts`'s `typeDescriptor()` treats any `$ref` as an opaque label
(`'ref:' + lastSlashSegment(ref)`) and never resolves it. This works by accident for
same-document refs to `#/components/schemas/X`, because the top-level walk over
`components.schemas` already flattens `X` independently under its own name. It does
**not** work when `$ref` points outside the document — e.g. `./schemas/user.yaml#/User` —
because that schema is never fetched, so fields deleted/mutated inside it are invisible
to the diff. That's the actual v1 blind spot this track closes.

### Design

- New pure file `src/lib/diff/resolveRefs.ts` (Law 2 — no IO):
  - `findExternalRefs(spec, basePath): string[]` — walk the parsed spec (same recursive
    shape `flattenSchema.ts` already walks) and collect every `$ref` string that is a
    **relative file path** (contains `/` before any `#`, or has no `#` at all), resolved
    against `basePath` (the directory of the spec file that referenced it). Depth-capped
    at `MAX_REF_RESOLUTION_DEPTH` (new env, default 5) purely as a recursion guard on the
    caller side (this function itself is one level).
  - `mergeExternalRefs(spec, resolved: Map<string, Record<string, unknown>>): Record<string, unknown>` —
    pure structural merge: for every external `$ref` found, splice the referenced
    document's `components.schemas` entries into the root spec's `components.schemas`
    under synthesized names (`<relativePath>#<originalName>`), and rewrite the original
    `$ref` string to point at the synthesized local name. Cycle-safe via a visited-set
    keyed by normalized ref target — a ref that resolves back to an ancestor is left
    unresolved (falls back to today's opaque `ref:` label) rather than looping.
- New IO file `src/lib/github/fetchExternalRefs.ts` (Spec E extension):
  - `resolveSpecRefs(octokit, params): Promise<Record<string, unknown>>` — orchestrates:
    `findExternalRefs` → bounded-concurrency fetch of each target via the existing
    `fetchFileText` (Contents API, same repo/ref as the spec itself — Law 11's Contents
    exception already covers spec files) → `parseOpenApiSpec` each → recurse up to the
    depth cap → `mergeExternalRefs`. Uses `mapWithConcurrency` (Law 9), not a new
    unbounded fetch pattern.
- Pipeline integration (Wave V2, see §5): `processPullRequest.ts` calls
  `resolveSpecRefs` on both `oldSpec` and `newSpec` immediately after `parseOpenApiSpec`,
  before `diffOpenApiSchemas`. An unresolvable/failed external ref is **not** fatal to the
  whole PR (Law 10 spirit extended to field-level): the field simply stays absent from
  the diff, same as today's behavior for any ref the tool doesn't understand.

### Decision: file refs only, no URL refs — **not deferred, rejected for v2**

`$ref` values that are absolute URLs (`https://...`) are deliberately **not** resolved.
Fetching an attacker-influenced URL from a webhook-triggered backend process is an SSRF
vector (internal network / cloud-metadata endpoint access) and an easy DoS lever (slow or
huge remote response) — the PR body is fully attacker-controlled input. File refs are
safe because they resolve through the same GitHub App installation credentials already
scoped to the repo being scanned; URL refs would need a new, separate trust boundary
(scheme allowlist, DNS-rebind protection, response size/time caps, maybe an explicit
per-link opt-in) that's a security review in its own right. Recommendation: leave URL
refs opaque (today's behavior) permanently, or revisit as its own dedicated spec later —
do not fold it into Track L.

### Acceptance sketch

- Multi-file fixture: `openapi.json` has `paths` referencing `./schemas/user.yaml#/User`;
  deleting a field inside `user.yaml`'s `User` schema is detected as `DELETED`.
- Circular ref (`a.yaml` refs `b.yaml` refs `a.yaml`) does not hang or stack-overflow.
- Depth-exceeded chain degrades to the field being silently absent from the diff, not a
  pipeline error.

## 2. Track M — Renamed-field detection

### Current behavior (correct, just unhelpful)

A rename already surfaces as a `DELETED` breaking change today — correct, because
frontend code referencing the old name genuinely does break. What's missing is the
*hint*: nothing tells the PR author "this looks like a rename, update references to
`newName`" instead of a bare "field deleted."

### Design

- **Type amendment (v2 Wave V0, one deliberate re-open of the frozen contract):** add one
  optional field to `BreakingChange` in `src/types/contract.ts`:
  ```ts
  export interface BreakingChange {
    field: string;
    parent: string;
    change: ChangeKind;
    original?: string;
    updated?: string;
    renamedTo?: string; // NEW — set only when detectRenames finds an unambiguous match
  }
  ```
  Additive and optional — no existing reader of `BreakingChange` breaks. This is the
  **only** frozen-type edit in all of v2; see §7.
- New pure file `src/lib/diff/detectRenames.ts`:
  - `annotateRenames(changes, oldMap, newMap): BreakingChange[]` — for every `DELETED`
    change in `parent` P with field X, find fields present in `newMap` under the same
    parent P that are **not** present in `oldMap` (candidate additions) whose `type`
    exactly equals `oldMap.get(P+'.'+X).type`. If exactly one such candidate Y exists,
    and Y hasn't already been claimed by another deletion in this same pass, set
    `renamedTo: Y`. Zero or multiple candidates → leave `renamedTo` unset (no guess on
    ambiguity — a wrong rename hint is worse than no hint).
  - `diffSchemas.ts` gains one line: call `annotateRenames(changes, oldMap, newMap)`
    before the existing sort. No signature change to `diffOpenApiSchemas` — same
    `(oldSpec, newSpec) => BreakingChange[]` contract, so nothing else in the codebase
    (pipeline, tests) needs to know this ran.
- `report/formatComment.ts` amendment: when rendering a `DELETED` change with
  `renamedTo` set, render `` `age` was removed (looks like it was renamed to `ageYears`)
  `` instead of the plain "was removed" line. `verdict.ts` conclusion logic is
  **unchanged** — a rename is still a breaking change if referenced; `renamedTo` only
  improves the message, never the pass/fail outcome.

### Acceptance sketch

- Unambiguous rename (`age` deleted, `ageYears: integer` added, only candidate) →
  `renamedTo: 'ageYears'`.
- Ambiguous rename (two same-typed added candidates in the same parent) → no
  `renamedTo` on either.
- Type also changed during the rename (`age: integer` → `ageInYears: string`) → not
  flagged (types must match exactly; a coincidental type-compatible rename guess across a
  type change is exactly the wrong-guess case being avoided).

## 3. Track N — Retries / durable queue beyond `after()`

### Current risk

`route.ts` acks 202 then runs the pipeline inside `after()`. If the process is killed
mid-work (execution-time limits, cold-start eviction) rather than throwing a catchable
error, Law 10's fail-open `catch` never runs — the check run can be left hanging at
`in_progress` with no retry. GitHub does retry webhook *delivery* itself on a non-2xx
response, but by the time `after()` starts, the route has already returned 202, so GitHub
sees success and won't redeliver even if the deferred work later dies silently.

### Design

- **Opt-in, not a replacement.** A queue is configured only if `QSTASH_TOKEN` is set
  (new `loadQueueEnv()` in `src/config/env.ts`, following the exact `loadDashboardEnv()`
  precedent — separate optional loader, never folded into `loadEnv()`/`Env`). Unconfigured
  deployments keep today's `after()` behavior byte-for-byte. This avoids a breaking
  change for every existing deployment (including the live one at `guardrail-coral.vercel.app`).
- **No new npm dependency.** Per Law 13's strict approved-dependency list, use raw
  `fetch()` against Upstash QStash's HTTP publish API and hand-rolled HMAC verification
  of its callback signature via `node:crypto` — the same shape `verifySignature.ts`
  already uses for GitHub's webhook HMAC. New file `src/lib/queue/qstash.ts`:
  - `publishPipelineJob(env, input: PipelineInput): Promise<void>` — `POST
    https://qstash.upstash.io/v2/publish/{processUrl}` with `Authorization: Bearer
    ${QSTASH_TOKEN}` and `PipelineInput` as the JSON body.
  - `verifyQStashSignature(rawBody, signatureHeader, signingKeys): boolean` — verifies
    against QStash's documented HMAC scheme, checking both the current and next signing
    key (QStash's key-rotation contract), `crypto.timingSafeEqual` per Law 4's spirit.
- New route `src/app/api/webhook/process/route.ts`: the QStash delivery target. Verifies
  the QStash signature (a **separate** trust boundary from GitHub's — never reuses
  `GITHUB_WEBHOOK_SECRET`), parses `PipelineInput` from the body, and **awaits**
  `processPullRequest` directly (no `after()` needed — QStash already grants this
  invocation its own timeout/retry budget). Returns 200 on completion, a non-2xx on an
  unexpected throw so QStash retries delivery.
- `src/app/api/webhook/github/route.ts` amendment: after HMAC verification, branch on
  whether `loadQueueEnv()` succeeds. If configured: **await** `publishPipelineJob`
  before acking (fast — a single HTTP round trip — and if publish fails, respond with a
  5xx so GitHub's own webhook-delivery retry covers it, rather than acking 202 into a
  job that never got enqueued). If not configured: today's `after()` path, unchanged.
- **Idempotency (the sharp edge a queue introduces) — TWICE-REVISED after two rounds of
  adversarial review, both catching real gaps:**
  - **Round 1** found: the original design claimed a delivery-id at ingress
    (`webhook/github/route.ts`) was sufficient. It is not — **QStash's own retries land
    on the `process` route directly, never back through ingress** — so an ingress-only
    claim never sees them, and the GitHub Checks API does **not** dedupe check runs with
    the same name/SHA. Fix proposed: keep the ingress claim AND add idempotent
    check-run creation.
  - **Round 2 found the ingress claim itself was actively harmful, not merely
    insufficient — REMOVED entirely, not kept as a belt-and-suspenders layer.** Claiming
    a delivery id BEFORE the work it guards is durably handed off means the claim can
    outlive the work: if `publish()` throws, the handler returns `502` specifically so
    GitHub retries — but the retry hits the same claim and gets silently dropped as a
    "duplicate," so the PR is never evaluated. The `after()` fallback has the identical
    shape (claim commits, process dies mid-`after()`, any GitHub redelivery is
    swallowed the same way), and there is no code path that can safely release the
    claim on either failure mode. **The design now rests on exactly one mechanism:**
    `createInProgressCheckRun` (`checks.ts`) becomes idempotent — before `POST`ing a new
    check run, it looks up existing (non-`completed`) runs for that repo+sha+name and
    reuses one if found. This has no equivalent failure mode: an attempt that created
    nothing lets a retry proceed and create fresh; one that created an in-flight run
    gets it reused. No `processed_deliveries` table, no `src/lib/db/deliveries.ts`, no
    migration `0004` — full reasoning in `docs/specs/N-retry-queue.md`'s Purpose
    section, which documents the rejected design so it isn't reintroduced by accident.
  - **This means `checks.ts` is no longer untouched by v2** — Track O's
    aggregated-verdict decision (§4) still holds (one check run per PR, not per
    frontend), but Track N edits this file for an unrelated reason (idempotency, not
    aggregation).
  - A benign (non-error) duplicate delivery now costs one full redundant pipeline
    evaluation instead of a cheap DB-row check — accepted; never silently dropping a PR
    evaluation matters more here than that avoided round-trip.

### Acceptance sketch

- No `QSTASH_TOKEN` set → route behaves exactly as it does on `main` today (regression
  test: existing e2e fixture unchanged).
- `QSTASH_TOKEN` set → route publishes and acks only after publish succeeds; `process`
  route processes the job and concludes the check run.
- Same delivery redelivered twice, via either path → `createInProgressCheckRun` reuses
  the existing in-progress run rather than creating a duplicate; a redundant full
  pipeline re-evaluation is the accepted cost, not a dropped PR.
- One **manual** live verification against a real QStash sandbox before shipping (mirror
  the live-verification entry already in `IMPLEMENTATION_LOG.md` for v1 — unit/e2e tests
  mock the publish call; only a real run proves the callback round-trip).

## 4. Track O — Multi-frontend fan-out

### Current constraint

`0001_project_links.sql`: `backend_repo_id BIGINT NOT NULL UNIQUE` — one row per backend
repo, full stop. `getProjectLinkByBackendRepoId` returns `ProjectLink | null` via
`.maybeSingle()`. `processPullRequest.ts` is written end-to-end around exactly one link:
one check run, one comment, one frontend scan.

### Design

- Migration `0005_multi_frontend.sql` (the file is numbered `0005`, not `0004` — `0004`
  was originally reserved for Track N's `processed_deliveries` table, which was later
  removed entirely; §3 above has the full story. The gap is harmless — migration numbers
  need to be unique and monotonic, not contiguous — so the file was left as `0005`
  rather than renumbered after the fact):
  ```sql
  ALTER TABLE project_links DROP CONSTRAINT project_links_backend_repo_id_key;
  ALTER TABLE project_links
    ADD CONSTRAINT project_links_backend_frontend_unique
    UNIQUE (backend_repo_id, frontend_repo_id);
  ```
- `src/lib/db/projectLinks.ts`: add `getProjectLinksByBackendRepoId(db, backendRepoId):
  Promise<ProjectLink[]>` (plural — new function, additive; the existing singular
  function stays, since Spec K's dashboard link-management flows key off `link.id`, not
  backend-repo lookup, and other call sites may still want it). Empty array when no links
  exist — no behavior change to "unregistered repo" handling.
- `processPullRequest.ts` restructure — **kept deliberately conservative**: rather than
  computing the contract diff once and fanning out only the scan (which would require
  assuming every link for a backend repo shares the same `openapi_file_path`, which the
  schema does not actually guarantee — each `project_links` row sets its own), extract
  today's entire steps 2–11 verbatim into a private `processLinkForPr(deps, input,
  link): Promise<void>` that **never rejects** (same total fail-open contract the current
  function already has end-to-end). The exported `processPullRequest` becomes: resolve
  links (plural) → empty → skip (unchanged) → `mapWithConcurrency(links,
  maxFrontendLinksConcurrency, link => processLinkForPr(...))`. `mapWithConcurrency`
  rejects on the *first* worker error (per `concurrency.ts`'s own doc comment) — safe
  here only because `processLinkForPr` is required to swallow everything internally,
  exactly as the current function already does.
  - New env `MAX_FRONTEND_LINKS_CONCURRENCY` (default 3) — a second, independent
    concurrency axis from `SCAN_CONCURRENCY` (files within one frontend). Note in the
    risk register: worst case is `3 × 8 = 24` concurrent GitHub API calls, still well
    inside App-installation rate limits, but the two caps compound and should be
    documented together, not tuned in isolation.
  - The common case (exactly one link) produces byte-identical behavior to v1 — this is
    the regression safety net: today's e2e fixture becomes an N=1 case of the new loop.
### Decision: one aggregated verdict per PR — **RESOLVED**

Confirmed by the user: multi-frontend fan-out posts **one** check run and **one** comment
per backend PR, not one per frontend. Consequence: `checks.ts`/`comments.ts` need **no**
per-link naming or marker changes at all — `CHECK_NAME` and `COMMENT_MARKER` stay exactly
as they are today. All the aggregation logic instead lives in a new pure module and a
`processPullRequest.ts` restructure, both owned by Track P (§5a) rather than Track O
itself, to avoid Track O and Track M both editing `formatComment.ts` in the same
parallel wave (see §5's file-disjointness note).

- **Track O's scope narrows to exactly one file:** `src/lib/db/projectLinks.ts` gains
  `getProjectLinksByBackendRepoId` (plural). Nothing else changes in Wave V1.
- **Aggregation (Track P, Wave V2):** each link is evaluated independently (own spec
  fetch/parse/diff/scan — `openapi_file_path` can differ per row, so this cannot be
  hoisted out to a single shared diff) into a `LinkOutcome`:
  ```ts
  type LinkOutcome =
    | { kind: 'evaluated'; verdict: Verdict; changes: BreakingChange[]; scan: ScanReport;
        frontendRepoFullName: string; openapiFilePath: string }
    | { kind: 'no-spec' } | { kind: 'spec-added' } | { kind: 'spec-removed' }
    | { kind: 'spec-unparseable'; message: string }
    | { kind: 'frontend-unreachable' } | { kind: 'internal-error'; message: string };
  ```
  mirroring exactly the six outcomes `processPullRequest.ts` already handles per-link
  today (each already resolves to a conclusion today: `spec-added`→`success`; the other
  five non-`evaluated` cases→`neutral`). New pure `src/lib/report/aggregateVerdicts.ts`:
  `aggregateVerdicts(outcomes): Verdict` — **worst-wins** conclusion priority
  (`failure` > `neutral` > `success`) across all links' resolved conclusions, so one
  link's internal hiccup can never hide a real `failure` found in another link, and can
  never itself escalate past `neutral` (Law 10 still holds per-link). `shouldComment` is
  true if any link's is true. `formatComment.ts` gains a multi-link composer that
  concatenates each `evaluated` link's existing per-link section (extracted from today's
  `formatPrComment` body, marker/footer emitted once for the whole comment, not once per
  link).
- Single-link case is byte-identical: with exactly one link, `aggregateVerdicts` reduces
  to the existing `computeVerdict` output and the multi-link comment composer reduces to
  today's single-section body — same acceptance-fixture regression safety net as before.

### Acceptance sketch

- Two links, one backend repo: frontend A doesn't reference the changed field, frontend B
  does → **one** check run concludes `failure` (worst-wins), **one** comment shows both
  frontends' sections (A's "no references" note, B's broken-reference table).
- One link (today's common case): identical check-run conclusion/title/summary and
  identical comment body to what's on `main` right now — today's e2e fixture passes
  unmodified.

## 5. Wave structure

Same wave-loop/gate discipline as `PLAN.md §4` (orchestrator spawns per-track agents,
waits, runs the global gate, repairs on failure — max 2 repair rounds per wave, escalate
to human if still red).

```
Wave V0 (sequential, one agent — mirrors W0's role)
  - src/types/contract.ts: add BreakingChange.renamedTo (Track M, the ONLY frozen-type edit)
  - src/config/env.ts: add loadQueueEnv() (Track N) and MAX_REF_RESOLUTION_DEPTH /
    MAX_FRONTEND_LINKS_CONCURRENCY to the existing loadEnv() (Tracks L, O)
  - supabase/migrations/0005_multi_frontend.sql (Track O — Track N ended up with no
    migration at all; see §4's note on the 0004 gap)

Wave V1 (4 parallel tracks — verified file-disjoint below, so genuinely parallel-safe)
  L   src/lib/diff/resolveRefs.ts, src/lib/github/fetchExternalRefs.ts        (new files only)
  M   src/lib/diff/detectRenames.ts (new); diffSchemas.ts, formatComment.ts   (edits)
  N   src/lib/queue/qstash.ts, src/app/api/webhook/process/route.ts,
      src/app/api/webhook/github/route.ts,
      src/lib/github/checks.ts (edit — idempotent createInProgressCheckRun, the SOLE
      idempotency mechanism in this track — see §3's twice-revised idempotency note)
  O   src/lib/db/projectLinks.ts                                             (edit, additive)

  File-disjointness check: L touches no existing file. M touches diffSchemas.ts +
  formatComment.ts, neither touched by L/N/O. N touches webhook/github/route.ts and
  checks.ts, neither touched by any other Wave V1 track. O touches only projectLinks.ts (aggregation verdict — §4 — moved the
  rest of Track O's original scope to Track P specifically so it wouldn't collide with
  M's formatComment.ts edit in the same parallel wave). None of L/M/N/O touch
  processPullRequest.ts — that's reserved for Wave V2 below, same reasoning as v1's H
  track being a dedicated glue-file wave.

Wave V2 (sequential integration, one agent — mirrors v1's H-track role — Track P)
  - src/lib/pipeline/processPullRequest.ts: wire in resolveSpecRefs (L, ahead of
    diffOpenApiSchemas) and restructure into a per-link evaluate + aggregate loop over
    the plural links (O's `getProjectLinksByBackendRepoId`).
  - New src/lib/report/aggregateVerdicts.ts (worst-wins conclusion priority, §4).
  - formatComment.ts gains a multi-link composer (extends, does not conflict with, M's
    already-merged rename-messaging edit — this wave runs strictly after Wave V1 lands).
  - N needs no pipeline.ts edit — its queue is entirely upstream of the pipeline
    (route.ts / process/route.ts call it, not the reverse).

Wave V3 (verification loop — mirrors v1's audit loop)
  - New/expanded fixtures: multi-file spec ($ref), renamed-field spec, multi-link
    project_links row, queue-mode route test (publish call mocked; one manual live
    QStash-sandbox run before ship, logged in IMPLEMENTATION_LOG.md same as v1's live
    verification).
  - spec-auditor pass against the new specs once L-O's docs/specs/*.md exist.
```

## 6. Track → spec → agent assignment (once specs are authored)

| Track | Spec file (to author) | Agent | Parallel with |
|---|---|---|---|
| V0 | `docs/specs/V0-v2-types-env-migrations.md` | `module-builder` | — (must finish first) |
| L | `docs/specs/L-ref-resolution.md` | `module-builder` | M N O |
| M | `docs/specs/M-rename-detection.md` | `module-builder` | L N O |
| N | `docs/specs/N-retry-queue.md` | `module-builder` | L M O |
| O | `docs/specs/O-multi-frontend.md` | `module-builder` | L M N |
| P | `docs/specs/P-pipeline-v2-integration.md` | `module-builder` | — (Wave V2, runs after V1) |
| V3 | `docs/specs/J-verification.md` amendment | `module-builder` then `spec-auditor` | — |

## 7. Frozen-type diff (the one deliberate re-open)

```diff
 export interface BreakingChange {
   field: string;
   parent: string;
   change: ChangeKind;
   original?: string;
   updated?: string;
+  renamedTo?: string; // Track M — set only on an unambiguous same-type rename match
 }
```

No other type in `src/types/` changes. `ProjectLink`, `PipelineInput`, `UsageMatch`,
`Verdict`, `ScanReport`, `CheckConclusion` are all untouched — multi-frontend fan-out
(Track O) is a query-arity and pipeline-loop concern, not a type-shape concern.

## 8. Proposed Law amendments (NOT yet adopted — pending sign-off, then fold into CLAUDE.md)

- **Law 5 extension:** "If a queue is configured (`QSTASH_TOKEN` set via
  `loadQueueEnv()`), the webhook route publishes to the queue and acks 202 only after the
  publish succeeds; `process/route.ts` (invoked by the queue) does the actual pipeline
  work. If no queue is configured, `after()` is used exactly as in v1." Law 5's core
  ("ack fast, never await the pipeline before responding") is preserved either way.
- **New Law (check-run idempotency, not delivery-claim idempotency):**
  "`createInProgressCheckRun` must look up and reuse an existing non-completed run for
  the same repo+sha+name before creating a new one — this is the ONLY idempotency
  mechanism for redelivered/retried webhook and queue jobs. Do not add a delivery-id
  claim table as a second layer: claiming before work is durably handed off has no safe
  release path on a downstream failure, so it silently swallows the retries it would
  exist to protect (docs/specs/N-retry-queue.md's Purpose section has the full incident
  this law is written from)."
- **Law 13 addendum:** no new npm dependency for Track N — QStash is integrated via raw
  `fetch()` + hand-rolled HMAC, consistent with the existing approved-dependency
  minimalism.
- Laws 1, 2, 6, 7, 8, 9, 10, 11, 14, 15, 16 need no amendment — every design above was
  fit to them, not the reverse.

## 9. Risk register (v2 additions)

| Risk | Mitigation | Track |
|---|---|---|
| SSRF via attacker-controlled `$ref` URL | URL refs never resolved — file refs only, same App-installation trust boundary | L |
| Circular/deep `$ref` chains hang the pipeline | Visited-set + `MAX_REF_RESOLUTION_DEPTH` cap, degrades to opaque label | L |
| Wrong rename guess misleads the PR author | Unambiguous-match-only heuristic + `namesLikelyRelated` name-relation gate (added after the shared v1/v2 fixture exposed a real false positive: `phoneNumber`→`middleName`, same parent/type, no actual relation) | M |
| Queue retry or GitHub's own webhook retry double-runs the pipeline | `createInProgressCheckRun` idempotency (reuse an existing non-completed run) — the SOLE mechanism, after a delivery-claim-table design was tried and rejected for silently swallowing the retries it existed to protect (§3) | N |
| Second HMAC trust boundary (QStash) reuses the GitHub secret by mistake | Separate signing-key pair, never `GITHUB_WEBHOOK_SECRET` | N |
| Existing deployments without `QSTASH_TOKEN` break | Queue is opt-in; `after()` path is untouched when unconfigured | N |
| N-link fan-out overwhelms GitHub API rate limits | Independent `MAX_FRONTEND_LINKS_CONCURRENCY` cap (default 3), documented alongside `SCAN_CONCURRENCY` | P |
| One link's internal error masks or is masked by another link's real failure | `aggregateVerdicts` worst-wins priority (`failure` > `neutral` > `success`) — a real failure always dominates a sibling error, and no per-link error can escalate past `neutral` | P |
| Migration numbering collision (Tracks N and O both add a migration in parallel) | Orchestrator fixes final numbering at merge time, not agents | N, O |

## 10. Explicitly out of scope for v2

- URL-based `$ref` resolution (§1 — rejected, not deferred, on SSRF grounds).
- Per-frontend independent check runs/comments (§4 — resolved in favor of one aggregated
  verdict per PR).
- Any change to how a *single*-frontend, *single*-spec-file deployment behaves — v2 is
  additive capability, not a rewrite; the entire wave structure in §5 is built around
  that constraint.
- Non-OpenAPI contract formats, non-TypeScript/JS frontend scanning, GitLab/Bitbucket
  support — untouched, not part of this backlog.
