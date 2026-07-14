# Guardrail — v3 Implementation Plan

Companion to `docs/PLAN.md` (v1) and `docs/PLAN_V2.md` (v2 — complete, merged at
`2312c01`, CI- and live-verified 2026-07-13). v3 is scoped from PLAN_V2 §10's
out-of-scope list plus the loose ends v2 left open:

1. **Track Q — Severity / ignore configuration.** A repo-versioned
   `guardrail.config.json` lets a backend team suppress or downgrade specific breaking
   changes, turning "Guardrail blocks everything it detects" into "Guardrail enforces
   what the team has not explicitly opted out of."
2. **Track R — Run history + dashboard browsing.** Every pipeline run is recorded
   (fail-open) and browsable from the Spec K dashboard: per-PR verdicts, conclusions,
   and per-link outcomes over time.
3. **Wave X0 housekeeping — adopt the v2 §8 Law amendments** into `CLAUDE.md` (Law 5
   queue extension, check-run-idempotency law, Law 13 QStash addendum). They shipped in
   code in v2 but are still marked "pending sign-off" in the constitution.
4. **Track S — GraphQL SDL contract support (STRETCH, GATED).** Not scheduled into any
   wave until the Law 13 dependency decision in §4 is signed off. If rejected, S moves
   to v4 wholesale; Q and R do not depend on it.

**Status: PLANNED — not started.**

## 0. Ground rules carried over

Everything in `CLAUDE.md` applies unmodified except the Wave X0 amendment adoption and
the one deliberate frozen-type addition in §6. In particular Law 1 (frozen types), Law 2
(pure core / IO shell), Law 10 (fail-open), Law 11 (Contents API only for spec-sized
config fetches), Law 13 (approved deps), Law 16 (branch per change) constrain every
design below.

## 1. Model & agent policy (new in v3)

v2's postmortem evidence: all three real defects (rename false-positive, the
delivery-claim idempotency architecture flaw, the QStash URL-encoding bug) were caught
by **adversarial design review before implementation**, not by the final audit. v3 makes
that explicit by splitting roles across model tiers:

| Role | Model | Used for |
|---|---|---|
| **Advisor / orchestrator** | **Fable** (main session — never a subagent) | Authoring every spec in `docs/specs/`, adversarial design review of each track BEFORE its implementation agent is spawned, resolving mid-wave conflicts and stop-and-report escalations, running wave gates (`typecheck` + full `vitest` + `lint`), Law-16 merges, and the final live verification sign-off. |
| **Simple coding** | **Sonnet** (`module-builder`, `model: sonnet`) | Mechanical, well-specified tracks: migrations, env/type additions, DB adapters, IO fetch adapters, dashboard API route + UI, doc edits. Anything where the spec fully determines the code and the blast radius of a mistake is one file caught by its own tests. |
| **Complex coding** | **Opus** (`module-builder`, `model: opus`) | Tracks with subtle semantics or verdict-affecting logic: the rules engine (Q1 — it changes pass/fail outcomes), the Wave X2 pipeline integration (the only glue file), and Track S's diff engine if approved. |
| **Audit / verify** | **Opus** (`spec-auditor`, `model: opus`) | The Wave X3 adversarial audit of every implemented file against its spec and every CLAUDE.md Law. Never Sonnet — the audit exists to catch what the builders missed, so it must not share their tier. |

Dispatch rule for repair rounds: a fix goes back to the tier that owns the file's track
(a Sonnet track's typo fix stays Sonnet; anything touching verdict logic or the pipeline
escalates to Opus). Fable itself never writes track code — it writes specs, reviews
designs, and gates waves. Escalation order is unchanged from v1/v2: max 2 repair rounds
per wave, then stop and report to the human.

## 2. Track Q — Severity / ignore configuration

### Current behavior

Every detected breaking change with a frontend reference is a `failure`, full stop.
There is no way for a team to say "we know, this break is intentional and coordinated"
short of merging over a red check.

### Design

- **Config file, not dashboard state.** Rules live in `guardrail.config.json` at the
  **backend repo root**, fetched from the PR's **head ref** via the existing Contents
  API adapter (Law 11's spec-fetch exception covers small config files; enforce a 64 KB
  raw-size cap — larger configs are treated as unparseable). Rationale: rules are
  versioned and code-reviewed with the code they excuse, need no new tables, and work
  identically for every link. Dashboard rule-editing is explicitly out of scope (§9).
- **Rule shape** (new additive shared types, `src/types/rules.ts` — a NEW file, not an
  edit to a frozen one):
  ```ts
  export type RuleAction = 'ignore' | 'warn';
  export interface Rule {
    action: RuleAction;
    parent?: string;  // exact match on BreakingChange.parent, e.g. "User"
    field?: string;   // exact match on BreakingChange.field, e.g. "phoneNumber"
    // at least one of parent/field must be present; both present = AND
  }
  export interface RuleSet { version: 1; rules: Rule[] }
  export interface AppliedRules {
    changes: BreakingChange[];   // surviving changes (ignored ones removed)
    ignoredCount: number;        // suppressed before scanning
    warnedFields: string[];      // fields whose failures downgrade to neutral
  }
  ```
  Exact-match only in v3 — no globs, no regex. A wrong suppression is worse than a
  missing convenience, same reasoning as Track M's unambiguous-only rename heuristic.
- **Semantics:**
  - `ignore` — the matching `BreakingChange` is removed BEFORE the frontend scan (the
    field is never scanned for; cheaper and unambiguous).
  - `warn` — the change is scanned and reported normally, but if it alone would have
    produced `failure`, the conclusion for that link downgrades to `neutral` with an
    explicit "downgraded by guardrail.config.json" annotation. A `warn` rule can never
    upgrade anything and never suppresses the report text — only softens the conclusion.
- **New pure files (Law 2 — no IO):**
  - `src/lib/rules/parseRuleset.ts` — `parseRuleset(rawJson: string): RuleSet | { error: string }`.
    Strict validation: unknown `version`, unknown `action`, a rule with neither
    `parent` nor `field`, or non-conforming JSON → error. An invalid config is
    reported in the PR comment and then **ignored entirely** (all rules dropped —
    fail-open means Guardrail still evaluates; it does NOT mean broken rules silently
    suppress findings).
  - `src/lib/rules/applyRules.ts` — `applyRules(changes: BreakingChange[], ruleset: RuleSet | null): AppliedRules`.
    Pure, order-independent, `null` ruleset = identity (today's behavior).
- **New IO file:** `src/lib/github/fetchRepoConfig.ts` —
  `fetchGuardrailConfig(octokit, params): Promise<string | null>` (`null` = file absent,
  the common case; absent config = byte-identical v2 behavior).
- **Visibility is the anti-gaming mechanism.** The PR author controls the config file in
  the same PR that introduces the break — that is by design (the suppression is itself
  reviewable in the diff), but the comment and check summary must ALWAYS state
  `N breaking change(s) suppressed / downgraded by guardrail.config.json` whenever
  `ignoredCount > 0` or `warnedFields` is non-empty, so a reviewer can't miss it.

### Acceptance sketch

- No config file → pipeline output byte-identical to v2 (existing e2e fixture unchanged).
- `ignore` rule matching a deleted-and-referenced field → `success` conclusion, comment
  notes 1 suppressed change.
- `warn` rule on the only failing change → `neutral`, full broken-reference table still
  rendered, downgrade annotation present.
- Invalid JSON / unknown version → all rules dropped, verdict identical to no-config,
  comment carries a "config invalid: <reason>" warning line.
- Rule matching nothing → zero effect, no suppression note.

## 3. Track R — Run history + dashboard browsing

### Current gap

Guardrail's only memory of a run is the GitHub check run + PR comment. The dashboard
(Spec K) manages links but shows nothing about what Guardrail has actually done.

### Design

- **Migration `0006_pipeline_runs.sql`:**
  ```sql
  CREATE TABLE pipeline_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      backend_repo_id BIGINT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha VARCHAR(64) NOT NULL,
      conclusion VARCHAR(16) NOT NULL,        -- 'success' | 'failure' | 'neutral'
      title VARCHAR(255) NOT NULL,
      link_outcomes JSONB NOT NULL DEFAULT '[]'::jsonb,  -- per-link kind + conclusion + repo name
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX pipeline_runs_backend_repo_idx
      ON pipeline_runs (backend_repo_id, created_at DESC);
  ```
  No FK to `project_links` — a run must remain recordable even if the link is deleted
  later, and history must survive link re-creation.
- **New row type** in `src/types/db.ts` (`PipelineRunRow` — the ONE deliberate additive
  edit to a frozen-type file in v3; see §6).
- **New adapter** `src/lib/db/pipelineRuns.ts`:
  - `insertPipelineRun(db, run): Promise<void>` — **must never throw** (catch-all inside;
    a history-write failure is logged per pipeline logging rules and swallowed). Run
    history is an observer, never a gate — Law 10 taken one step further: it cannot even
    conclude `neutral`, it just goes missing.
  - `listPipelineRuns(db, backendRepoId, limit = 50): Promise<PipelineRunRow[]>` —
    newest-first.
- **Dashboard API** `src/app/api/dashboard/runs/route.ts` — `GET ?backend_repo_id=...`,
  session-guarded via the existing `requireSession.ts` helpers, and authorized the same
  way link reads are: the caller must have dashboard access to that backend repo (reuse
  the Spec K accessible-repos check — never trust the query param alone).
- **Dashboard UI** `src/app/dashboard/RunHistory.tsx` (new client component) rendered
  from `page.tsx` beneath the existing `LinkManager`: per selected backend repo, a table
  of recent runs (PR #, sha short, conclusion badge, title, relative time). Read-only in
  v3 — no drill-down page, no pagination beyond the 50-row limit.

### Acceptance sketch

- Pipeline run with a working DB → exactly one row inserted, `conclusion` matches the
  concluded check run, `link_outcomes` has one entry per link.
- `insertPipelineRun` rejecting (DB down) → pipeline verdict and comment unaffected
  (unit test: the mock throws; the check still concludes).
- API route without a session → 401; with a session lacking access to that repo → 403;
  happy path returns newest-first rows.
- Unregistered repo (skip path) → NO row inserted (skips are not runs).

## 4. Track S — GraphQL SDL support (STRETCH — gated, not scheduled)

The natural next contract format, structurally parallel to OpenAPI: parse SDL → flatten
type fields → same `BreakingChange` diff → same scanner. **But:** Law 13's approved list
has no GraphQL parser, and hand-rolling a spec-compliant SDL parser is larger than all
of Q + R combined — that path is rejected, not just deferred.

**Gate (stop-and-report, per Law 13):** Track S proceeds only if the human approves
adding `graphql@^16` (the reference SDL parser, zero transitive runtime deps) to the
approved-dependency list via a CLAUDE.md amendment. Decision needed before any Track S
spec is authored. If approved, S becomes its own mini-wave AFTER X3 (design: pure
`src/lib/diff/graphql/` behind the existing `BreakingChange` contract; a per-link
`contract_format` column, migration `0007`). If not approved, S moves to v4 and nothing
else in v3 changes.

## 5. Wave structure

Same wave-loop/gate discipline as v1/v2 (orchestrator = Fable spawns per-track agents,
waits, runs the global gate, dispatches repairs — max 2 repair rounds per wave). Every
track's spec gets a Fable adversarial design review BEFORE its builder is spawned
(§1 rationale).

```
Wave X0 (sequential, ONE module-builder, model: SONNET — fully mechanical)
  - CLAUDE.md: fold in the three v2 §8 Law amendments (adopted by this plan's sign-off)
  - src/types/rules.ts (new file: RuleAction, Rule, RuleSet, AppliedRules)
  - src/types/db.ts: add PipelineRunRow (the ONLY frozen-file edit — §6)
  - supabase/migrations/0006_pipeline_runs.sql

Wave X1 (4 parallel tracks — file-disjointness verified below)
  Q1  rules engine        OPUS    src/lib/rules/parseRuleset.ts, applyRules.ts   (new, pure)
  Q2  config fetch        SONNET  src/lib/github/fetchRepoConfig.ts              (new, IO)
  R1  run persistence     SONNET  src/lib/db/pipelineRuns.ts                     (new, IO)
  R2  dashboard API + UI  SONNET  src/app/api/dashboard/runs/route.ts (new),
                                  src/app/dashboard/RunHistory.tsx (new),
                                  src/app/dashboard/page.tsx (edit)

  File-disjointness: Q1, Q2, R1 are new-files-only. R2's single edit (page.tsx) is
  touched by no other track. No Wave X1 track touches processPullRequest.ts,
  formatComment.ts, verdict.ts, or aggregateVerdicts.ts — all reserved for Wave X2,
  same glue-wave reasoning as v1's Track H and v2's Track P.

Wave X2 (sequential integration, ONE module-builder, model: OPUS — Track T)
  - src/lib/pipeline/processPullRequest.ts: fetch config once per PR (head ref) →
    parseRuleset → applyRules per link (each link diffs its own spec, so rules apply
    to each link's changes independently) → after concluding, insertPipelineRun
    (fail-open, never awaited into the verdict path's error handling).
  - src/lib/report/formatComment.ts + aggregateVerdicts.ts: LinkOutcome's `evaluated`
    arm carries ignoredCount/warnedFields; suppression note + downgrade annotation
    rendered once per link; `warn` downgrade applied where the link's conclusion is
    resolved (worst-wins aggregation itself is UNCHANGED).
  - verdict.ts computeVerdict signature: UNCHANGED (downgrade is applied to its
    output, not inside it — nothing else that calls it needs to know).

Wave X3 (verification loop)
  - Fixtures: config-file e2e variants (ignore / warn / invalid / absent), run-history
    insert + fail-open tests, dashboard route auth tests.
  - spec-auditor (OPUS) against all new/amended specs + every CLAUDE.md Law.
  - Fable: live verification on a real guardrail-demo PR (add a guardrail.config.json
    with an ignore rule → check goes green with the suppression note; run appears in
    the dashboard), logged in docs/IMPLEMENTATION_LOG.md same as v1/v2.
```

## 6. Frozen-type diff (the one deliberate re-open)

`src/types/rules.ts` is a new file (additive, not a re-open). The single edit to an
existing frozen file is `src/types/db.ts`:

```diff
+/** One recorded pipeline run (Track R). Additive — see docs/PLAN_V3.md §6. */
+export interface PipelineRunRow {
+  id: string;
+  backend_repo_id: number;
+  pr_number: number;
+  head_sha: string;
+  conclusion: 'success' | 'failure' | 'neutral';
+  title: string;
+  link_outcomes: unknown[]; // JSONB payload; shaped by pipeline, read-only in UI
+  created_at: string;
+}
```

`BreakingChange`, `Verdict`, `ScanReport`, `UsageMatch`, `ProjectLink`, `PipelineInput`
are all untouched. `LinkOutcome` (in `aggregateVerdicts.ts`, not `src/types/`) gains
optional suppression fields in Wave X2 — it is Track P/T-owned, not a frozen contract.

## 7. Track → spec → agent → model assignment

| Track | Spec file (to author — Fable) | Agent | Model | Parallel with |
|---|---|---|---|---|
| X0 | `docs/specs/X0-v3-types-laws-migration.md` | `module-builder` | Sonnet | — (first) |
| Q1 | `docs/specs/Q-rules-engine.md` | `module-builder` | **Opus** | Q2 R1 R2 |
| Q2 | `docs/specs/Q-rules-engine.md` (File section 2) | `module-builder` | Sonnet | Q1 R1 R2 |
| R1 | `docs/specs/R-run-history.md` | `module-builder` | Sonnet | Q1 Q2 R2 |
| R2 | `docs/specs/R-run-history.md` (dashboard section) | `module-builder` | Sonnet | Q1 Q2 R1 |
| T | `docs/specs/T-pipeline-v3-integration.md` | `module-builder` | **Opus** | — (Wave X2) |
| X3 | `docs/specs/J-verification.md` amendment | `spec-auditor` | **Opus** | — |
| S | gated — see §4; spec authored only after dep sign-off | `module-builder` | **Opus** | — (post-X3) |

## 8. Law amendments

**Adopted at v3 kickoff (Wave X0 edits CLAUDE.md):** the three v2 §8 amendments,
verbatim.

**Proposed by v3 (pending sign-off, folded in at v3 merge):**
- **Rules-visibility law:** "Whenever `applyRules` suppresses or downgrades anything,
  the check summary and PR comment MUST state the count. An invalid
  `guardrail.config.json` drops ALL rules (full enforcement) and is reported — a broken
  config may never silently suppress a finding."
- **History-is-an-observer law:** "`insertPipelineRun` never throws and is never allowed
  to affect a verdict, comment, or check conclusion. Run history is written after the
  check concludes, not before."
- **Law 13 (conditional, Track S only):** add `graphql@^16` — only if §4's gate is
  approved.

## 9. Risk register (v3 additions)

| Risk | Mitigation | Track |
|---|---|---|
| PR author silences their own break via config in the same PR | By-design reviewability (config change is in the reviewed diff) + mandatory always-on suppression count in comment AND check summary | Q |
| Invalid config silently drops enforcement | Strict parse; invalid → ALL rules dropped (full enforcement) + warning line, never partial application | Q |
| Rule glob/regex complexity creep | Exact-match only in v3; pattern matching is a v4 decision, not an implementation convenience | Q |
| Config fetch adds a per-PR API call for repos that never use it | Single Contents fetch, `null` fast-path on 404, no retry — absent file costs one round trip | Q |
| History write slows or breaks the verdict path | `insertPipelineRun` runs after check conclusion, catch-all inside, unit-tested with a throwing mock | R |
| `pipeline_runs` grows unbounded | Accepted for v3 (index covers reads; retention/TTL is a v4 ops decision, noted here so it isn't forgotten) | R |
| Dashboard route leaks other users' run history | Authorization reuses Spec K's accessible-repos check server-side; `backend_repo_id` param is never trusted alone | R |
| GraphQL dep approved casually without review | Track S is hard-gated on an explicit CLAUDE.md Law 13 amendment sign-off; no spec authored before it | S |
| Sonnet builder under-implements a subtle spec | Verdict-affecting and glue tracks are Opus by policy (§1); wave gate + Opus audit are tier-independent backstops | all |

## 10. Explicitly out of scope for v3

- Dashboard rule editing (rules are repo-file-only; a UI editor is v4+).
- Glob/regex/path-prefix rule matching (exact `parent`/`field` match only).
- Run-history retention/TTL and drill-down UI (list view only).
- Per-frontend independent check runs (unchanged v2 decision).
- URL-based `$ref` resolution (unchanged v2 rejection — SSRF).
- Non-TypeScript frontend scanning, GitLab/Bitbucket support.
- GraphQL support **unless** §4's dependency gate is explicitly approved.
