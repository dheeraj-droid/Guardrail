# Implementation Log

Running record of implementation work: what changed, where, and the outcome. Append an
entry per logical change (matches the Law 16 branch-per-change granularity) — this is a
record of what happened, not a plan.

## 2026-07-09

**CI workflow** (`chore/add-ci-workflow`, merged to `main`)
- Added `.github/workflows/ci.yml`: runs `npm ci`, `npm run typecheck`, `npm test` on
  push to `main` and on every pull request.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`.

**Docs sync** (`docs/sync-dashboard-docs`, merged to `main`)
- Updated CLAUDE.md's "Repository map" to cover the Spec K dashboard/auth surface
  (`src/lib/auth/`, `src/app/api/auth/`, `src/app/api/dashboard/`, `src/app/api/links/`,
  `src/app/api/_lib/`, `src/app/dashboard/`) and "Environment variables" to document the
  5 dashboard-only vars (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_SLUG`, `GUARDRAIL_SESSION_SECRET`, `APP_BASE_URL`).
- Updated README.md's stale "160 tests" claim to the verified actual count (177).
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Verified with
  `npm run typecheck` (clean) and `npm test` (24 files / 177 tests passing) after merge.

**ESLint setup** (`chore/add-eslint-config`, merged to `main`)
- Adds `eslint@^9` + `eslint-config-next@^16` as dev dependencies (explicitly authorized
  as an exception to CLAUDE.md Law 13's approved-dependency list; the config package's
  major version doesn't need to track the app's `next@^15` since it has no `next` peer
  dependency), a flat `eslint.config.mjs`, and a `lint` script.
- First two attempts didn't land (one interrupted by the user before committing, one hit
  a transient API connection error before creating its branch) — third attempt succeeded.
- 8 lint violations left deliberately unfixed (documented in the branch's commit/PR
  context): `any` casts in test fixtures/helpers where fixing risks breaking AST-scanner
  fixture assertions, plus two real-but-minor findings (`LinkManager.tsx` calling
  setState synchronously in a `useEffect`, `layout.tsx` using `<a>` instead of
  `next/link` for internal navigation) left for a deliberate follow-up rather than a
  reflexive fix.
- `npm run lint` is NOT wired into `.github/workflows/ci.yml` — it would fail CI
  immediately given the 8 known violations. Follow-up decision needed: fix the
  remaining violations and then gate CI on lint, or leave lint local-only for now.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`.

**Fix: ESLint scanning stray worktree directories** (`fix/eslint-ignore-worktrees`, merged to `main`)
- Discovered while re-verifying locally: `eslint.config.mjs` had no `ignores` entry for
  `.claude/worktrees/`, so `npm run lint` was scanning every git worktree sitting under
  that path — including one from an unrelated, separately-locked session
  (`chore+finish-v1-gaps`, branch `feat/element-access-scanning`), which inflated the
  violation count from 8 to 18 with duplicate/irrelevant findings. That worktree was not
  touched.
- Added `{ ignores: [".claude/**"] }` to `eslint.config.mjs`; also committed a
  `package-lock.json` sync from running `npm install` locally (harmless optional-dependency
  resolution churn).
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Re-verified on
  `main`: `npm run typecheck` clean, `npm run lint` back to the expected 8 problems,
  `npm test` 24/24 files, 177/177 tests passing.

**Fix: broken `package-lock.json` was failing CI on `ubuntu-latest`** (`fix/regenerate-package-lock`, merged to `main`)
- All local verification up to this point ran on Windows/Node 24 and only ever checked
  `npm run typecheck`/`test`, never the actual GitHub Actions run — so two pushes to
  `main` had silently gone red without being noticed. Caught by explicitly checking
  `gh run list` after the fact.
- Root cause: `npm install` run locally (to sync `node_modules` after the ESLint agent's
  worktree-only install) produced a lockfile missing platform-specific optional-dependency
  entries (`@emnapi/runtime@1.11.2`, `@emnapi/core@1.11.2`) that `npm ci` on
  `ubuntu-latest` needs — `npm ci` refuses to proceed on any package.json↔lock drift
  (`EUSAGE`).
- Fix: `rm -rf node_modules package-lock.json && npm install`, then verified with
  `rm -rf node_modules && npm ci` locally (the exact command CI runs) before pushing.
- Outcome: merged `--no-ff`, branch deleted, pushed. **Confirmed green on the actual
  GitHub Actions run** (`gh run watch`), not just local checks — run
  `29041079947`, `build` job, 46s, all steps passed.

**Fix: ESLint excluding `tests/fixtures/**`** (`fix/eslint-exclude-fixtures`, merged to `main`)
- Correction to the earlier ESLint entry above: the `any`-cast violations in
  `tests/fixtures/profile.tsx`/`settings.ts` were left unfixed with the reasoning "fixing
  them risks breaking AST-scanner assertions" — that reasoning was wrong. Per Law 7 the
  scanner is syntactic (`PropertyAccessExpression`/`BindingElement`), so a fixture's
  declared type has no effect on what it detects. The correct reasoning: fixtures are
  deliberately-crafted sample frontend source, not maintained application code, so they
  shouldn't be linted at all — same category as `.claude/**`.
- Added `tests/fixtures/**` to `eslint.config.mjs`'s `ignores`. Violation count dropped
  from 8 to 4 (the two real findings in `LinkManager.tsx`/`layout.tsx`, plus the two
  documented intentional `any` casts in `tests/helpers/fakeGithub.ts` and
  `tests/pipeline/processPullRequest.test.ts`).
- Outcome: merged `--no-ff`, branch deleted, pushed. Confirmed green on the actual
  GitHub Actions run (`29041262749`, 44s).

## 2026-07-10

**Bracket-notation field scanning** (`feat/element-access-scanning`, merged to `main`)
- Closed a documented v1 false-negative gap (`PLAN.md §7`, `docs/specs/C-ast-scan.md`
  "Forbidden"): `astScanner.ts` previously only matched dot-access
  (`PropertyAccessExpression`) and destructuring (`BindingElement`), so
  `user["phoneNumber"]` shipped undetected — a deleted/type-mutated field used via
  bracket notation would silently pass the check.
- Added a checkpoint: `ts.isElementAccessExpression(node)` with a string-literal
  `argumentExpression`, recorded with the existing `kind: 'property-access'` (no change to
  the frozen `UsageMatch` type — Law 1). Dynamic keys (`user[key]`) stay untracked, same
  as before.
- Added 3 acceptance tests (bracket literal match, dynamic-key skip, multi-hit columns);
  updated `docs/specs/C-ast-scan.md` and `docs/PLAN.md §7` to reflect the new checkpoint
  instead of listing it as out-of-scope/forbidden.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Verified with
  `npm run typecheck` (clean) and `npm test` (24 files / 180 tests passing).

**Verified and pushed the above bracket-notation work** — it had been merged into local
`main` but not yet pushed when discovered mid-session (from a separate concurrent
session working in a locked worktree). Reviewed the diff directly (code, tests, spec/plan
doc updates), ran the full local verify (`typecheck`/`lint`/`test`, 180/180 passing, no
new lint violations) before pushing. By the time push was confirmed, the other session had
already pushed it itself — `git push` reported "Everything up-to-date".

**Fix: `layout.tsx` used `<a>` instead of `next/link`** (`fix/layout-use-next-link`, merged to `main`)
- `@next/next/no-html-link-for-pages`: the root layout's brand link to `/` was a plain
  `<a>`, forcing a full page reload for an internal route instead of client-side nav.
- Swapped for `<Link href="/">` from `next/link`. No behavior change beyond navigation
  becoming client-side.
- Outcome: merged `--no-ff`, branch deleted, pushed. Confirmed green on the actual
  GitHub Actions run (`29042752747`).

**Fix: suppressed `react-hooks/set-state-in-effect` in `LinkManager.tsx`** (`fix/suppress-set-state-in-effect`, merged to `main`)
- The mount effect calls `load()`, which itself calls several `setState`s. `load` is also
  called after create/delete mutations (2 other call sites) to refresh the list, so
  inlining the fetch into just the effect would mean duplicating that logic three times —
  worse than the thing being flagged. This is the standard single mount-time fetch
  pattern (one effect, fires once, nothing chains off the state it sets), not the
  effect-cascade pattern the rule targets.
- Added a scoped `eslint-disable-next-line` with an in-code comment explaining why, and
  what to do if this needs to be un-suppressed later: if `load`/this component ever grows
  a second effect reacting to `repos`/`links`/`loading`/`error`, split `load` into a pure
  fetch-and-return function and have each call site (mount, post-create, post-delete) do
  its own `setState` from the result.
- Outcome: merged `--no-ff`, branch deleted, pushed. Confirmed green on the actual
  GitHub Actions run (`29043038692`). Lint is now down to 2 problems — both the
  documented intentional `any` casts in test helpers.

**Fix: documented and suppressed the last 2 `any` casts** (`fix/document-any-casts`, merged to `main`)
- Both `findCall()` test helpers (`tests/helpers/fakeGithub.ts`, `tests/pipeline/processPullRequest.test.ts`)
  already had a JSDoc explaining the `any` return type; added the matching scoped
  `eslint-disable-next-line @typescript-eslint/no-explicit-any` so lint actually passes
  instead of just being explained. `npm run lint` now reports 0 problems.
- Outcome: merged `--no-ff`, branch deleted, pushed. Verified `npm run typecheck`
  (clean), `npm run lint` (0 problems), `npm test` (24 files / 180 tests passing).

**Chore: gate CI on `npm run lint`** (`chore/gate-ci-on-lint`, merged to `main`)
- With lint at 0 violations (previous entry), added `npm run lint` to
  `.github/workflows/ci.yml` between `typecheck` and `test` so future lint regressions
  fail CI instead of accumulating silently.
- Outcome: merged `--no-ff`, branch deleted, pushed. Verified locally (`typecheck`
  clean, `lint` 0 problems, `test` 24 files / 180 tests) before pushing; confirm on the
  next GitHub Actions run that the new `lint` step executes and passes.

**Closed:** the ESLint follow-up items (2 real findings + CI gating) noted as "still
open" above are now all resolved.

**Docs: sync README/PLAN/DEPLOY to the verified v1-complete state** (`docs/update-v1-status`, merged to `main`)
- Verified current state directly rather than trusting prior doc claims: `npm run
  typecheck` (clean), `npm run lint` (0 problems), `npm test` (24 files / 180 tests
  passing).
- `README.md`: updated the stale "177 tests green" Status line and "177 tests" comment to
  180; reworded Status to state v1 (specs A–K + W0, all build waves) is complete and
  CI-verified, while keeping the existing caveat that it hasn't been run end-to-end
  against a live GitHub App / Supabase / Vercel deployment on a real PR.
- `docs/DEPLOY.md`: fixed a stale "127-test suite" reference (Local development section)
  to 180.
- `docs/PLAN.md`: added a one-line Status note under the intro pointing to this log for
  the change-by-change record; confirmed §7 ("Out of scope for v1") does not list
  bracket-notation scanning as forbidden (already corrected by the
  `feat/element-access-scanning` entry above) — no further edit needed there.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Verified
  `npm run typecheck` (clean), `npm run lint` (0 problems), `npm test` (24 files / 180
  tests passing) before pushing.

**Docs: v2 implementation plan** (`docs/plan-v2`, merged to `main`)
- Added `docs/PLAN_V2.md`, planning the four items `PLAN.md §7` listed as out-of-scope
  for v1: $ref resolution (repo-relative file refs only — URL refs rejected on SSRF
  grounds, not deferred), renamed-field detection (additive `BreakingChange.renamedTo`,
  the only frozen-type edit in the whole plan), retries/queues beyond `after()` (opt-in
  via a new `QSTASH_TOKEN`-gated `loadQueueEnv()`, no new npm dependency, plus a
  `processed_deliveries` idempotency table — **later rejected and removed during Wave V1
  implementation, see the Wave V1 entry below; this line is left as originally written
  to keep the log an accurate record of what was planned at the time**), and
  multi-frontend fan-out (drops
  `project_links.backend_repo_id`'s solo `UNIQUE`, loops `processPullRequest`'s existing
  per-link logic under bounded concurrency rather than assuming a shared spec across
  links).
- Grounded every design decision in the actual current source (`processPullRequest.ts`,
  `flattenSchema.ts`, `diffSchemas.ts`, `checks.ts`, `comments.ts`, `concurrency.ts`,
  `env.ts`, the two existing migrations) rather than speculating — e.g. corrected an
  initial assumption that the OpenAPI diff could be computed once and fanned out across
  frontend links; each `project_links` row can set its own `openapi_file_path`, so the
  plan instead fans out the whole existing per-link pipeline as one unit.
  Laid out a 4-wave structure (V0 types/env/migrations → V1 four parallel tracks,
  verified file-disjoint → V2 single-agent pipeline.ts integration → V3 verification),
  proposed (not yet adopted) Law amendments, and flagged two open decisions for sign-off:
  rejecting URL-based `$ref` resolution, and keeping per-frontend check runs/comments
  independent rather than aggregating multi-frontend results into one verdict.
- Scope confirmed with the user via `AskUserQuestion` before drafting: all four v1-backlog
  items in, no additional new-scope items.
- No `docs/specs/L-*.md` .. `O-*.md` files written yet — authoring those at v1's spec
  fidelity is the deliberate next step, not part of this entry.
- Outcome: docs-only change, no code/tests affected; `npm run typecheck` and `npm run
  lint` re-verified clean before pushing.

**Docs: confirm live end-to-end run, drop the stale "not yet run" caveat** (`docs/confirm-live-e2e-run`, merged to `main`)
- The prior entry's README caveat ("not yet run end-to-end against a live deployment on a
  real PR") turned out to be false: the live deployment (`guardrail-coral.vercel.app`),
  GitHub App (`guardrail-app`), and Supabase project were already wired up, and PR #1 on
  `dheeraj-droid/guardrail-demo` (opened 2026-07-08) already had a real `Guardrail Contract
  Check` run — verified directly via `gh api .../check-runs`, not from docs.
- Re-verified live, not just from history: pushed an empty commit to that PR's branch to
  trigger a fresh `synchronize` webhook. New check run completed 2026-07-09T19:45:53Z,
  concluded `failure`, correct schema diff (`age` TYPE_MUTATED, `phoneNumber` DELETED),
  correct 4 frontend references across 3 files including the destructuring-alias case
  (`{ phoneNumber: phone }` matched on `phoneNumber`, per Law 6), and the PR comment was
  updated in place (comment count stayed at 1) rather than duplicated.
- `README.md`: replaced the "not yet run end-to-end" caveat with a statement of what was
  actually verified live, linking the deployment and demo repo.
- Outcome: merged `--no-ff`, branch deleted, pushed to `origin/main`. Verified
  `npm run typecheck` (clean) and `npm run lint` (0 problems) before pushing.

## 2026-07-11

**v2 build, Waves V0–V3** (branch `feat/v2`, pushed to `origin/feat/v2`, **not merged to
`main`** — see outcome note). Orchestrated as background `module-builder` (Sonnet) agents
per track, one per wave, with every substantive design/security decision manually
reviewed before merge into the branch — not delegated to the agents' own self-reports.

- **Wave V0** (`42d6df6`) — sequential, single agent: `BreakingChange.renamedTo` (the only
  frozen-type edit in all of v2, Law 1), `loadQueueEnv()`/`QueueEnv` (mirrors
  `loadDashboardEnv()`), `maxRefResolutionDepth`/`maxFrontendLinksConcurrency` on `Env`,
  `0005_multi_frontend.sql`. 3 test files outside V0's own scope had `Env` literals
  missing the two new fields — fixed directly (mechanical), not by respawning the agent.
- **Wave V1** (`b70e2a0`, `31cff56`, `4edccdd`, `4649182`) — 4 parallel tracks, verified
  file-disjoint per `PLAN_V2.md §5` before spawning:
  - **L** (`resolveRefs.ts`, `fetchExternalRefs.ts`) — cross-file `$ref` resolution, file
    refs only (URL refs rejected on SSRF grounds, `isRelativeFileRef()` rejects any
    `scheme://` prefix). Finished cleanly; its background agent hit a 600s no-progress
    watchdog after the work was already done — verified via `git status` and committed
    rather than respawned.
  - **M** (`detectRenames.ts`) — renamed-field hint on `DELETED` changes. **Caught a real
    false positive during review**: the original same-parent/same-type heuristic flagged
    the shared test fixture's unrelated `phoneNumber`→`middleName` pair as a rename. Fixed
    by adding a `namesLikelyRelated()` name-relation gate (substring or shared camelCase
    word) before accepting a rename candidate; verified against the exact fixture pair
    that was wrong.
  - **N** (`qstash.ts`, `webhook/process/route.ts`, `checks.ts` idempotency) — opt-in
    QStash retry queue. **Two real defects caught and fixed before merge, not found
    later by audit:** (1) the original design claimed a delivery id at ingress before
    handing work off durably — a `publish()` failure or `after()` crash left the claim
    committed with no safe release path, silently swallowing the exact retries it existed
    to protect. Root-caused, then removed entirely; the sole idempotency mechanism is now
    `createInProgressCheckRun` reusing an existing non-completed run for the same
    repo+sha+name (see `PLAN_V2.md §3`'s twice-revised design history). (2) the publish
    URL was building `` `.../v2/publish/${encodeURIComponent(processUrl)}` `` — verified
    against Upstash's actual published curl example that the destination must be passed
    raw; fixed. First implementation attempt wrote nothing before a 600s watchdog fired;
    respawned with an explicit "do not call the advisor tool" instruction and it
    succeeded on the second attempt.
  - **O** (`projectLinks.ts`) — added plural `getProjectLinksByBackendRepoId`, extracted
    shared `toProjectLink()` helper (behavior-preserving). Clean.
  - Cross-track regression: Track N's new check-run idempotency `GET` call broke 11/12
    tests in `tests/pipeline/processPullRequest.test.ts` because the fake-Octokit route
    table didn't register the new route. Track N's agent correctly identified this,
    correctly left it unfixed (outside its file scope), and it was fixed directly in both
    the test file and `tests/helpers/fakeGithub.ts`.
- **Wave V2** (`5d5dd05`, Track P) — sequential pipeline integration. Rewrote
  `processPullRequest.ts` around a `LinkOutcome` union and a private `evaluateLink()` that
  never throws; new pure `aggregateVerdicts.ts` (worst-wins conclusion priority,
  `failure` > `neutral` > `success`); `formatComment.ts` gained a multi-link composer.
  This agent was killed mid-task once (resumed by the user, work recovered intact from
  `git status`) and separately hit an external session-limit API error after resuming
  (recovered again — real, substantial work was already sitting uncommitted). Before
  committing: manually verified the **degeneracy guarantee** (a single-link outcome
  array must produce byte-identical `{conclusion, title, summary, shouldComment}` to
  pre-v2 behavior) by reading `aggregateVerdicts.ts`'s `describe()` strings against the
  original v1 inline early-return text for all 7 `LinkOutcome` kinds, and confirmed
  `formatComment.ts`'s `buildSection()` extraction was behavior-preserving via diff.
  Also fixed, outside Spec P's file list but load-bearing: `tests/helpers/fakeGithub.ts`'s
  `makeDb()` rewritten to a thenable query-builder shape to match Track O's plural lookup
  (which awaits `.select().eq()` directly, never calls `.maybeSingle()`) — without this
  fix the e2e suite's 5 tests passed vacuously (link never found), not for the reason
  they claimed to.
- **Wave V3** — spec-auditor pass (read-only, adversarial) against all six track specs
  and every CLAUDE.md Law, cross-checked against `PLAN_V2.md §1-§4`'s acceptance
  sketches. **Zero code defects found.** Confirmed: Law 1 (only `renamedTo` touches
  frozen types), Law 2 (pure files have zero IO/Octokit/Supabase/next/env imports), Law 4
  (`verifyQStashSignature` uses `timingSafeEqual`), Law 5 (queue branch awaits `publish`
  before acking), Law 9 (`mapWithConcurrency` for both ref-fetch and link fan-out), Law 10
  (every new error path concludes `neutral`), Law 13 (`package.json` unchanged — no new
  dependency). Cross-track wiring confirmed correct (`resolveSpecRefs` runs on both old
  and new spec before diffing, for every link; `createInProgressCheckRun` filters on
  `run.name`, not just the query param). Every acceptance-sketch scenario has a real test
  (not just a plausible-looking one) — auditor cited exact file:line for each. One real
  gap, not a defect: the QStash live-sandbox round-trip Track N's spec mandates before
  shipping has not been performed (see outcome note below). One doc-staleness item fixed
  directly: `docs/specs/V0-v2-types-env-migrations.md` still listed the rejected
  `0004_processed_deliveries.sql` as a file to produce; annotated as rejected/not
  implemented rather than deleted, to preserve the design-history record.
- Gate at every wave boundary: `npm run typecheck`, `npm run lint`, `npm test` — final
  state 260/260 tests green across 30 files (up from v1's 180/24), typecheck clean, lint
  clean.
- **Outcome: intentionally NOT merged to `main`.** `feat/v2` is implementation-complete
  and CI-verified, but Track N's mandated live QStash verification hasn't been run, and
  Vercel auto-deploys from `main` — merging now would put the rewritten pipeline in front
  of real production PRs before that round-trip is confirmed. Pushed `feat/v2` to
  `origin/feat/v2`; the merge-to-`main` decision is deferred until the live QStash
  verification (or an equivalent smoke-test PR, mirroring the `docs/confirm-live-e2e-run`
  entry above) is done and logged here.
