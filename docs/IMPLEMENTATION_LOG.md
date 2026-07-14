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

**Premium dashboard/landing redesign** (`feat/premium-dashboard-ui`, PR opened, not yet
merged)
- Rewrote `src/app/globals.css` as a dark-first design system: color tokens, refined
  system-font typography (tight tracking on headings per Apple's optical-sizing
  guidance), card/table/form/button polish, `backdrop-filter` translucent sticky header,
  press feedback (`scale(0.97)` on `:active`), and a `prefers-reduced-motion` guard. Pure
  CSS only — no new dependency (Law 13 rules out Tailwind/Framer Motion/CSS-in-JS).
- `layout.tsx`: added a small gradient `brand-mark` next to the "Guardrail" wordmark.
- `page.tsx` (landing): added an eyebrow label above the H1; no logic changes.
- `LinkManager.tsx`: same states/handlers, restyled markup only — loading state now
  shows a CSS spinner, empty state gets a dedicated class, table wrapped in a horizontal
  `.table-scroll` container for small viewports.
- No component-render tests exist for these files (dashboard tests are API-route only),
  so no test changes were needed.
- Verification: `npm run typecheck` and `npm run lint` both clean. Ran `next dev` and
  confirmed live: landing page renders 200 with the new classes present
  (`eyebrow`/`brand-mark`/`notice-error`) across the default, `?error=auth`, and
  not-configured states. The real `/dashboard` route needs `GITHUB_APP_CLIENT_ID` etc.
  (not set locally) so it 500s before rendering, as it always has — added a temporary
  scratch route (`src/app/scratchpreview999/page.tsx`, mock data, deleted before commit)
  to confirm `LinkManager`'s loading/empty/error/populated states all compile and wire
  their new classes correctly.
- Caveat: no browser-automation/screenshot tool is available in this environment, so
  visual correctness (color contrast, spacing, gradients) was verified by careful CSS
  authoring against the `apple-design` and `emil-design-eng` skills plus structural
  HTTP/HTML checks, not by looking at rendered pixels. Worth a human visual pass before
  merging.
- Outcome: branch pushed, draft PR opened against `main` (not merged — background-job
  convention for this session; the human should review the actual look before merging).
- Follow-up after opening the PR: the advisor caught that `--color-primary-fg` was
  `#0a0b12` (near-black) on the `.button-primary` indigo gradient — plausible sub-4.5:1
  contrast at the darker gradient stop, and confirmed via `WebFetch` on the live
  production URL (`guardrail-coral.vercel.app`, shared by the user) that this button IS
  the default landing-page state in production (dashboard env is configured there), not
  a rare branch. Changed `--color-primary-fg` to `#ffffff`. Re-ran `npm run typecheck` /
  `npm run lint` clean (had to `rm -rf .next` first — stale generated route types from
  the deleted scratch preview route broke typecheck). Pushed as a second commit on the
  same branch/PR.

## 2026-07-11

**Landing + dashboard visual overhaul** (`feat/premium-dashboard-ui`, on the existing PR #5)
- Full frontend redesign to a Notion/Linear-grade dark aesthetic, building on the branch's
  earlier premium pass. Touched only the four frontend files (no logic changed):
  - `layout.tsx`: added `next/font/google` Inter (sans) + JetBrains Mono (mono) as CSS
    vars — no new package.json dependency (next/font ships with `next`, Law 13 safe).
    Reworked the header into a glass nav (How it works / Why Guardrail / GitHub) and added
    a site footer. `metadata` title/description sharpened.
  - `page.tsx` (landing): rebuilt into a two-column hero with a CSS/SVG "GitHub checks"
    product mockup (PR #482 removing `User.phoneNumber`, build/tests pass, Guardrail check
    fails with the two frontend usages + "Merging is blocked") — the money shot. Added
    how-it-works (3 steps), a why-Guardrail feature grid (4 cards), and a CTA band.
    Preserved verbatim: the `loadDashboardEnv()` try/catch, `configured`/`appSlug` gating,
    and the `?error=auth` notice branch.
  - `LinkManager.tsx`: markup/classes only — all state, handlers, CSRF header, monorepo
    toggle, and fetch logic untouched. New two-column form grid, richer empty/loading
    states, code-styled table cells, signed-in header.
  - `globals.css`: rewritten design system — refined tokens, fluid type scale, fixed
    ambient gradient + SVG film-grain layers, hero/check-card/steps/feature/CTA/footer
    styles, `scale(0.97)` button press, staggered entrance motion, full reduced-motion +
    responsive breakpoints.
- Verification: `npm run typecheck` and `npm run lint` both clean. Ran `next dev` (with a
  local dummy `.env.local`, gitignored) and confirmed the landing live via the browser —
  hero, check-card mockup, all sections, and responsive single-column stacking render
  correctly. The `/dashboard` route is session-gated (redirects without a real GitHub
  session), so its full-fidelity check is deferred to the Vercel preview for PR #5.
- Outcome: committed on `feat/premium-dashboard-ui`, pushed to update PR #5 (Vercel
  preview redeploys). Not merged — human visual review of the preview first.

## 2026-07-11 (cont.)

**De-slop pass on the premium redesign** (`feat/premium-dashboard-ui`, PR #5, same branch)
- The prior commit's redesign was visually confirmed live (`next dev` + browser screenshot)
  and, while structurally solid, read as generic "AI dark SaaS" on inspection — ran the
  `kill-ai-slop` skill's scanner (`node .claude/skills/kill-ai-slop/scripts/scan.mjs src`)
  and manually triaged the full 23-tell taxonomy against `globals.css`/`page.tsx`/
  `layout.tsx`. Confirmed 6 real tells (18 hits): gradient-clip headline text, three
  stacked atmospheric gradient blobs behind the whole page, a pulsing green glow-halo dot
  in the eyebrow badge, feature-grid icons tinted in a see-through wash of their own
  color (classic "icon in a tint of itself" + rounded-square-tile combo), a
  linen-gradient card surface (lighter-above-darker-below), and a tinted indigo glow
  shadow on buttons/step numbers instead of a colorless elevation shadow.
- Token-level fixes in `globals.css` only where possible (per the skill's own "fix tokens
  first" ordering): collapsed the two-hue indigo+cyan accent system to one held accent
  (dropped `--color-accent` and `--color-primary-deep`), replaced all gradient fills
  (button-primary, brand-mark, step-num, hero-title-accent, check-card surface, cta-band
  background) with solid fills, made `--shadow-pop`/`--shadow-float` colorless, removed
  the pulsing/halo animation on the eyebrow dot and the now-dead `pulse` keyframe,
  stripped the tinted icon-tile background/border from `.feature-icon` (icon now just
  carries the one accent color, no container), reduced the page-wide ambient gradient
  from 3 stacked radials to 1 restrained one over the hero only, and softened
  `.notice-error` from an all-one-hue wash to a neutral surface with color carried only
  in the text. `page.tsx`: removed the two now-unstyled glow-blob divs
  (`hero-visual-glow`, `cta-band-glow`).
- Deliberately left 5 groups/10 hits the scanner still flags, after reading each: the one
  remaining hero-top gradient (singular, restrained, points at one element — matches the
  skill's own "if a glow must exist, let it point at one element" exception); the sticky
  header's `backdrop-filter` blur (one functional translucent nav, not "every card a
  glass pane"); `formatComment.ts`'s warning emoji (backend PR-comment copy, out of this
  task's scope and outside the frontend files this branch touches); the `check-blocked`
  circle+diagonal-line icon (a standard prohibited/no-entry glyph, not a crude AI-drawn
  blob — scanner false positive); and mono-font usage, all of which is on real code
  (file paths, line numbers, a code-braces glyph) not UI chrome — not the "tasteful
  terminal" pattern.
- Verified: `npm run typecheck` clean, `npm run lint` 0 problems, `npm test` 180/180
  passing (no regressions). Reverted an incidental `package-lock.json` diff from a local
  `npm install` — it dropped the `@emnapi/*` optional-dependency entries that a prior
  entry in this log already fixed once for Linux CI; committing it again would have
  reintroduced that exact bug.
- Visual verification: got one real browser screenshot of the hero before fixing (visibly
  confirmed the gradient headline, pulsing dot, and gradient button described above).
  After the fixes, the in-app browser's screenshot/zoom capability was stuck
  (timed out repeatedly, independent of page/tab) for the rest of the session, so
  post-fix confirmation relied on `get_page_text`/`read_page` (content and structure
  intact, all links present) plus direct source review of each small, mechanical CSS
  change (removing a gradient/animation/tint is not layout-affecting). Also built and
  used a throwaway harness (`src/app/previewharness999/`, mocked the two dashboard
  fetches, deleted before commit) to confirm `LinkManager`'s populated/empty/error states
  still render correctly after the shared-token changes (buttons, notices, brand-mark
  are used on both landing and dashboard). A full pixel-level after screenshot is still
  worth a human pass on the Vercel preview.
- Outcome: committed on `feat/premium-dashboard-ui`, pushed to update PR #5.

## 2026-07-11 (cont. 2)

**Serif headline + apple-design accessibility pass** (`feat/premium-dashboard-ui`, PR #5)
- Added `Fraunces` (Google, variable, has a real optical-size axis) via `next/font/google`
  in `layout.tsx` as `--font-serif` — no new dependency (Law 13; `next/font` ships with
  `next`). Restricted strictly to headline moments: `.hero-title`, `.section-head h2`
  (both "How it works" and "Why Guardrail"), `.cta-band h2`, `.dashboard-intro h1`.
  Everything else (nav, body copy, buttons, form UI, card titles, dashboard table/form)
  stays on `--font-sans` (Inter) — one deliberate second voice with an exclusive job, not
  a "premium == serif" reflex applied broadly (the exact failure mode the kill-ai-slop
  skill's tell 08 warns about).
- Applied the apple-design skill's §15 typography discipline: tracking is size-specific,
  not one fixed `letter-spacing` — the hero (largest) got `-0.015em`, the smaller section
  h2s and dashboard h1 got a lighter `-0.01em`/`-0.008em` (serif also needs less negative
  tracking than the grotesque sans values the hero used before, since serif ductus already
  implies spacing). Added `font-optical-sizing: auto` on every serif heading so Fraunces'
  opsz axis actually engages. Most of the skill (springs, gesture velocity, drag momentum,
  rubber-banding) doesn't apply here — no draggable/gesture surfaces exist in this app, and
  Law 13 rules out an animation library regardless — so I only pulled the parts that
  transfer to a static page: typography (§15) and materials/reduced-motion accessibility
  (§12/§14). Added `prefers-reduced-transparency` and `prefers-contrast` media queries for
  the one translucent surface on the page (`.site-header`'s `backdrop-filter`) that drop
  the blur for a solid surface, per the skill's explicit guidance not to skip those signals
  just because there's only one blur to handle. The existing `:active { scale(0.97) }`
  press feedback was already aligned with §1 ("respond on pointer-down") — no change
  needed there.
- Verified: `npm run typecheck` clean, `npm run lint` 0 problems, `npm test` 180/180,
  and `npm run build` (production build, not just dev) succeeds — confirms the Fraunces
  font resolves correctly at build time, not just in the dev server. Visually confirmed
  live via the browser: got a real screenshot of the hero showing the serif headline
  rendering correctly with the de-slopped flat button/dot/accent color from the prior
  commit all still in place. The screenshot tool was intermittently stuck again for the
  rest of the page (feature grid, section headings) — those changes are the same
  mechanical pattern as the hero (font-family + tracking on an existing rule) so
  confirmed via source review rather than a second screenshot; genuinely lower-risk than
  the hero change already visually confirmed.
- Outcome: committed on `feat/premium-dashboard-ui`, pushed to update PR #5 (Vercel
  preview redeploys).

## 2026-07-11 (cont. 3)

**Real logo + favicon** (`feat/premium-dashboard-ui`, PR #5)
- `main` already had brand assets this PR branch didn't: `docs/assets/*.svg` (a coral
  `#E9564A` shield-with-checkmark mark, mono knockout, wordmark lockups, marketplace
  feature-card background) from 3 earlier docs commits, and `src/app/icon.svg`
  (Next.js App Router auto-registers `src/app/*icon.svg` as the favicon) from a separate
  `feat/favicon` commit — neither had been merged into this branch. Brought in the exact
  files (`git checkout main -- docs/assets src/app/icon.svg`) rather than merging `main`
  wholesale, since both branches have independently grown `docs/IMPLEMENTATION_LOG.md`
  entries at the end and a full merge would conflict there for no benefit — the asset
  files are byte-identical either way, so this reconciles cleanly whenever the PR
  eventually merges.
- `layout.tsx`: replaced the placeholder `.brand-mark` (a flat indigo CSS square) with
  the real logo, inlined as an SVG component (`BrandMark`) in both the header and footer
  brand links — crisp at 22px, no extra request. `globals.css`: `.brand-mark` now just
  sizes/aligns the SVG; dropped the background-fill/box-shadow rules that existed only to
  fake a mark in CSS.
- **Flagging, not fixing:** the real brand color is coral (`#E9564A`), confirmed
  deliberate by `docs/marketplace-media-checklist.md` ("badge background color that
  matches... the coral logo," "deep slate" surfaces). Every accent choice made in this
  PR's earlier sessions (buttons, the eyebrow dot, badges, the hero's colored word) uses
  indigo (`--color-primary: #8b93ff`) instead, chosen without knowledge of the real mark.
  With the actual logo now in the header, the mismatch is visible — two unrelated accent
  hues on one page, which is exactly what the "one accent, one voice" pass earlier in
  this branch was trying to avoid. Did not recolor the UI to coral: that's a much larger,
  highly visible diff (every button/badge/link across both files) and a real brand
  decision, not a mechanical fix — left for the user to confirm before touching it.
- Verified: `npm run typecheck` clean, `npm run lint` 0 problems, `npm test` 180/180,
  `npm run build` succeeds with `/icon.svg` appearing as a static route in the build
  output (confirms Next's auto favicon registration picked it up, not just that the file
  exists). Visually confirmed live via the browser: both the header and footer render the
  coral shield mark correctly next to "Guardrail," CTA band and footer layout unaffected.
- Outcome: committed on `feat/premium-dashboard-ui`, pushed to update PR #5.

## 2026-07-13

**Animated aurora background** (`feat/premium-dashboard-ui`, PR #5)
- User explicitly requested a moving, colorful background ("it needs to have life,"
  Notion as the reference) — this deliberately supersedes the earlier de-slop decision
  to hold one static gradient. What was slop as a default is now a defended choice; the
  discipline moved into *how* it's built instead of whether it exists.
- `globals.css`: replaced the static `body::before` radial with an `.aurora` layer —
  three large (52rem) heavily-blurred (90px) radial blobs: indigo `#6169f5` (the UI
  accent), coral `#E9564A` (the logo hue — ties the brand mark into the page), and a
  cyan. Each drifts on its own transform-only keyframe loop (`aurora-a/b/c`) with
  near-co-prime durations (47s/59s/37s, `alternate`) so the composition never visibly
  repeats. GPU-safe by construction: `transform` is the only animated property,
  `will-change: transform`, no layout/paint per frame. Blob opacity is low and the
  film-grain layer sits above them, so text contrast is unaffected. Reduced-motion:
  the global animation kill-switch freezes the drift, plus an explicit
  `.aurora span { animation: none; opacity: 0.7 }` so the frozen composition reads as
  soft ambient light, not three spotlights.
- `layout.tsx`: added the `.aurora` container (3 empty spans, `aria-hidden`) behind the
  grain layer.
- Verified: `npm run typecheck` clean, `npm run lint` 0 problems, `npm run build`
  succeeds. Visually confirmed via a real browser screenshot: indigo/coral/cyan wash
  visible behind the hero, text legible. Motion confirmed programmatically (the
  screenshot tool went stuck again after the first frame): sampled a blob's computed
  `transform` twice 2s apart via in-page JS — matrix values drifted
  (translate 0.18→7.29px, scale 1.0002→1.0081) and `document.getAnimations()` reported
  all three aurora animations plus the existing `rise` entrances running.
- Outcome: committed on `feat/premium-dashboard-ui`, pushed to update PR #5.

## 2026-07-13 (cont.)

**Light editorial redesign — full pivot** (`feat/premium-dashboard-ui`, PR #5)
- User shared 5 reference landing pages (Notion et al.) as the explicit quality bar and
  direction — light, editorial, huge type, one accent, black CTAs, product mockup on a
  vivid panel, dark footer with a giant wordmark. This supersedes the dark theme AND the
  aurora background from the previous entry (user: "I want these kind of frontends").
- `globals.css`: full rewrite as a light design system. White base, near-black ink,
  hairline rules, coral `#E9564A` as the ONLY accent (kills the indigo/coral clash
  flagged two entries ago — the logo hue now IS the accent), black primary buttons
  (reference pattern), quiet colorless shadows. Aurora and film-grain removed; Fraunces
  serif dropped (references are all sans) — headline voice is now Inter at 680 weight
  with -0.034em tracking.
- `page.tsx`: centered hero (badge, coral-accent headline phrase, black + outline CTAs,
  trust row), the GitHub-checks mockup restyled as a LIGHT card centered on a deep-slate
  grid-textured panel (the brand's marketplace feature-card look — the exact "light app
  UI on vivid panel" move from the calendar reference), 3-step how-it-works with black
  number squares, feature grid, NEW 6-item FAQ grid with one dark anchor card (reference
  pattern), CTA band. Env gating/notice logic preserved verbatim.
- `layout.tsx`: light glass header with a black Sign-in CTA, nav + FAQ link; dark footer
  with link columns and a giant clipped `GUARDRAIL` watermark (LaunchKit reference
  footer). Hash-anchor nav links converted to `<Link>` after lint caught 6
  `no-html-link-for-pages` errors.
- Verified: typecheck clean, lint 0 after the Link fix, tests 180/180, production build
  clean. Visual verification (screenshots, intermittently flaky tool): hero, product
  panel, and steps sections confirmed on-reference; FAQ (6 cards, 1 dark) + footer
  wordmark (208px computed) confirmed via in-page JS when screenshots hung.
- **Self-rating vs the 10/10 references: 8.5.** Known gaps to 10: no trusted-by/proof
  strip (nothing dishonest to put there yet), footer + FAQ not yet eyeballed as pixels,
  mobile pass not visually verified, hero could use a subtle texture/illustration touch.
- Outcome: committed on `feat/premium-dashboard-ui`, pushed to update PR #5.

**Iteration 2: proof strip + mobile verification** (same branch/PR)
- Added a Keel-reference-style stats strip under the product panel with three REAL
  numbers (no invented logos/customers): "3s verdict on the live demo PR" (the actual
  live check-run duration recorded in docs/marketplace-media-checklist.md), "180 tests
  green on every commit" (the suite), "100% open source on GitHub."
- Mobile pass verified programmatically at 375px (screenshot tool was down): zero
  horizontal overflow (scrollWidth 375 == viewport), hero scales to 40px, nav collapses
  to the Sign-in CTA, footer wordmark clips inside `overflow: hidden` as designed.
  Desktop 1440px: no overflow, proof strip renders all three stats.
- Verified: typecheck + lint clean. **Re-rating: 9/10.** Remaining to 10: pixel-level
  eyeball of FAQ/footer/mobile (blocked on the flaky screenshot tool — the Vercel
  preview is the better place for that), and possibly a hero texture/illustration
  accent. Stopping the loop here this session; the structure is at reference parity and
  the remaining delta is pixel-tuning against the live preview.
- Outcome: committed on `feat/premium-dashboard-ui`, pushed to update PR #5.

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
- **Outcome (as of this wave): intentionally NOT merged to `main`.** `feat/v2` is
  implementation-complete and CI-verified, but Track N's mandated live QStash
  verification hasn't been run, and Vercel auto-deploys from `main` — merging now would
  put the rewritten pipeline in front of real production PRs before that round-trip is
  confirmed. Pushed `feat/v2` to `origin/feat/v2`; the merge-to-`main` decision is
  deferred until the live QStash verification (or an equivalent smoke-test PR, mirroring
  the `docs/confirm-live-e2e-run` entry above) is done and logged here. **Superseded
  2026-07-13 — see the entry below: merged by explicit user decision before that
  verification, with production itself as the verification environment.**

**v2 merge to `main`** (plumbing merge commit `2312c01`, no branch — see note)
- Context: after being walked through the live-QStash-verification setup (Vercel preview
  deployment, temporary webhook repoint, forced redelivery), the user reported being
  unable to complete it and, after weighing the alternatives (wait, or use a disposable
  test App), made an explicit, informed decision: merge now, verify the queue path
  directly in production, and revert if it misbehaves. `QSTASH_TOKEN` was confirmed
  already configured in the **Production** Vercel environment (not Preview) at decision
  time — flagged to the user before proceeding, since it means the queue activates
  immediately on deploy rather than staying dormant.
- Pre-merge diligence (the user explicitly asked for a conflict check first):
  `git fetch` revealed `main` had moved 15 commits ahead of where `feat/v2` branched —
  13 local + 2 not-yet-fetched from `origin/main` (`docs/Privacy.md` and, notably, a new
  `src/app/api/github/marketplace/route.ts`, a plausible collision point with Track N's
  new `src/app/api/webhook/*` routes). Checked: no path overlap between the two; the only
  file both `feat/v2` and `main`'s branding commits touched was `README.md`, at
  non-overlapping line ranges (main added a wordmark header at the top, `feat/v2` added a
  Status paragraph further down).
- `git merge-tree --write-tree` (git 2.43, conflict-free dry-run) against the actual
  `origin/main` tip confirmed a clean, conflict-free merge before anything was written.
- Built the merge commit via `git commit-tree` (not `git merge`) because `main` was
  already checked out in a different worktree (the user's primary checkout) — checking it
  out here too isn't possible. This also meant the merge was never pushed as its own
  named branch; `feat/v2`'s tip is preserved as the merge commit's second parent.
- **Verified the merge commit itself before pushing**, not just the two branches
  separately: `git worktree add --detach` at the candidate merge SHA, `npm install`,
  then `npm run typecheck` (clean), `npm run lint` (clean), `npm test` (260/260, 30
  files), and `npm run build` (production build — catches Next.js route-conflict/build
  issues `tsc --noEmit` wouldn't; confirmed `/api/webhook/process` and
  `/api/github/marketplace` both compile as separate routes with no collision). Removed
  the temp worktree after.
- Pushed the verified commit directly to `origin/main` by SHA (`git push origin
  <sha>:refs/heads/main`), intentionally not touching any local branch ref — the user's
  primary checkout's local `main` was left exactly as it was, to update via a normal
  `git pull` on their own schedule rather than being silently rewritten underneath them.
  Deleted `origin/feat/v2` per Law 16 once its content was confirmed merged.
- Follow-up docs fix in the same sitting (branch `docs/log-v2-merge`, off the new
  `origin/main`): the merge itself had carried forward this doc's now-stale "not yet
  merged" language (auto-merged cleanly alongside `main`'s wordmark header, since they
  touched different line ranges) — corrected in `README.md`, `docs/PLAN.md`, and
  `docs/PLAN_V2.md`'s Status lines, plus test-count references (`180`→`260`,
  `24 files`→`30 files`) in `README.md` and `docs/DEPLOY.md`. Historical log entries
  above that cite `180`/`177` are left as-is — they're accurate records of what was true
  when written, not current-state claims.
- **Outcome: merged to `origin/main` (production auto-deploys from `main`).** The Track N
  live QStash verification described in the previous entry has **still not been
  performed** — this merge does not close that gap, it relocates where the verification
  happens (production, not a preview deployment), by explicit user risk-acceptance
  decision. `git revert -m 1 2312c01` is the rollback path if the queue path (or anything
  else in v2) misbehaves live. Verified: `npm run typecheck` (clean), `npm run lint`
  (clean), `npm test` (260/260) and `npm run build` (clean) at the exact commit before
  push, per the diligence note above — not re-run after, since nothing changed post-push.

**v2 Track N: live QStash verification, directly in production** (no branch — GitHub/
Vercel/Upstash actions plus verification via `gh api`; closes the gap left open by the
previous entry)
- Context: the previous entry's merge decision explicitly deferred Track N's mandated
  live QStash round-trip to production rather than a preview deployment. This entry is
  that verification.
- Triggered a real `pull_request.synchronize` webhook against production by pushing a
  commit to the existing live test PR
  ([guardrail-demo#1](https://github.com/dheeraj-droid/guardrail-demo/pull/1), the same
  rig used for v1's own live verification). Vercel request logs showed
  `[guardrail] concluding check run: failure — 4 broken frontend reference(s) to 2 schema
  change(s)` logged from inside `/api/webhook/process` — confirmed against
  `processPullRequest.ts:395` as a real code path, not a plausible-looking fake — proving
  the full round-trip: `webhook/github` → `publishPipelineJob` → real QStash → callback →
  `webhook/process` → pipeline → check run concluded. The resulting check run's
  conclusion, title, and PR comment content (4 references across 3 files, correct
  destructuring-alias resolution) matched v1's known-good output exactly — no regression
  from the Track P rewrite.
- Initially misread a pair of near-simultaneous `POST 202 /api/webhook/github` log lines
  as a duplicate delivery of the same event; checking GitHub App → Recent Deliveries
  showed they were actually two *different* event types (`pull_request.synchronize` +
  `check_suite.requested`) that GitHub always sends together for one push — the handler's
  event-type filter correctly no-ops the latter before it reaches the queue at all. Not a
  finding — corrected before it was logged as one.
- Real redelivery test: used GitHub's own Recent Deliveries → **Redeliver** on the
  `pull_request.synchronize` delivery (twice, ~25s apart). Read `checks.ts`'s actual
  `createInProgressCheckRun` implementation first rather than assuming behavior: it
  dedupes only against **non-completed** runs (`run.status !== 'completed'`). Since the
  original pipeline run completes in ~2s — far faster than either redelivery arrived —
  neither redelivery found an in-progress run to reuse; each legitimately created its own
  new check run. Verified via `gh api .../check-runs?filter=all` (the default `filter`
  query param is `latest`, which would have silently hidden this — first poll without
  `filter=all` showed only 1 run and would have produced a false "confirmed exactly one"
  conclusion): **3 check runs total for one commit** (`86762630502`, `86809084455`,
  `86809166947`), all concluding `failure` correctly. **Zero deliveries silently
  dropped** — the actual property Track N exists to guarantee, and the one the rejected
  `processed_deliveries` design would have violated. Separately confirmed:
  `upsertPrComment`'s marker-based idempotent update held across all three runs — PR
  comment count stayed at exactly 1, never duplicated.
- Correction to the original acceptance sketch (`docs/PLAN_V2.md §3`, updated in the same
  commit as this entry): "confirm exactly one check run results" was imprecise — dedup
  only applies to the narrower in-flight-retry case (unit-tested, no live case observed
  since real redeliveries arrive well after the ~2s completion window); the common
  post-completion case is a redundant full re-evaluation, which is what was actually
  observed and is the documented accepted cost, not a bug.
- Outcome: **v2 is now both CI-verified and live-verified.** Docs updated:
  `docs/PLAN_V2.md`'s Status line and §3 Acceptance sketch corrected to the precise,
  live-confirmed behavior; this entry is the log record `docs/PLAN_V2.md` points to.
  README.md's "not yet live-verified" caveat removed. No code changes — this is a
  verification-only entry; `git revert -m 1 2312c01` remains the rollback path if
  anything regresses later, unaffected by this entry.

## 2026-07-14

**Session-aware header/landing + motion polish** (three branches, all merged `--no-ff`
to `main`: `fix/session-aware-landing`, `fix/session-aware-header`, `feat/motion-polish`;
frontend code written by Opus subagents per user instruction)
- **Root cause of "sign-in button doesn't change after signing in":** the OAuth callback
  sets the `guardrail_session` cookie correctly, but neither the landing page nor the
  shared header ever read it — both unconditionally rendered "Sign in with GitHub".
- Mid-task discovery: local `main` was 31 commits behind `origin/main` (the whole v2 wave
  + the premium light editorial redesign above). The first session-aware pass
  (`fix/session-aware-landing`) was built against the stale UI; reconciled by merging
  `origin/main`, resolving all 4 conflicts in favor of the redesign, keeping the two new
  helper files, then re-applying session-awareness to the redesigned UI on
  `fix/session-aware-header`.
- Session-awareness (net result): new `src/app/sessionState.ts` (`resolveSessionState()`,
  tolerant of unset dashboard env — webhook-only deploys stay healthy) + new
  `src/app/SignOutButton.tsx` (CSRF-headered POST to `/api/auth/logout`). `layout.tsx` is
  now async/`force-dynamic`: signed-in users get an avatar chip (`github.com/<login>.png`)
  + `@login` linking to `/dashboard` and a quiet sign-out button; signed-out gets the old
  Sign-in CTA (only when configured). `page.tsx` hero + CTA band swap sign-in for
  "Go to dashboard →" when signed in. `LinkManager.tsx` dropped its duplicate Log out
  button (header owns sign-out now); kept "Signed in as @login". Only the `login` string
  crosses to the client — the GitHub token never reaches client markup.
- Motion polish (`feat/motion-polish`): product-panel check-card now *plays* on scroll-in
  (rows tick build → unit-tests → Guardrail ✗, detail reveals, "Merging is blocked"
  stamps; runs once, via new `ProductPanel.tsx` + IntersectionObserver); scroll reveals
  with CSS nth-child stagger (`Reveal.tsx`); proof stats count up (`CountUp.tsx`, rAF to
  textContent, SSRs final value — no hydration mismatch, no JS = correct numbers); CSS
  micro-interactions (button press/arrow nudge, card lifts, nav underline, `.h2-accent`
  underline sweep); dashboard got skeleton loading rows, a row-created highlight flash,
  and a "Saved ✓" button state. All progressive-enhancement (hidden pre-states only
  inside gated keyframes — fully visible without JS) and all collapsed under
  `prefers-reduced-motion`. Proof-strip copy corrected 180 → 260 tests. No new
  dependencies (Law 13) — CSS + three small client components.
- Verified on merged `main`: `npm run typecheck` clean, `npm test` 260/260 (30 files),
  `npm run lint` clean (subagent-run). Live via `next dev` + browser: hero screenshot
  clean; motion confirmed programmatically (screenshot tool intermittently stuck again,
  same as prior sessions): `.product-panel-wrap.is-playing` fired, all 4 `.reveal`
  groups became `.is-visible`, check rows/stamp animations active in computed style,
  `.h2-accent::after` sweep completed (`scaleX(1)`), count-ups landed on `3s / 260 /
  100%`, zero console errors. Signed-in state not drivable locally (dashboard env unset)
  — covered by the tolerant-helper design + suite; worth a click-through on production
  after deploy.
- Also: repaired `.claude/launch.json` (pointed at a deleted worktree's `dev.cmd`) with a
  repo-root `dev.cmd` (untracked local tooling).
- Outcome: all three branches merged `--no-ff` to `main`, branches deleted, pushed to
  `origin/main` together with this log entry.

## 2026-07-14 — Canvas particle backdrops + dashboard life pass

- Goal: user wanted "10/10" UI — moving geometric shapes behind the hero and a livelier
  dashboard. Aggressive-but-engineered motion, canvas particles (not CSS shapes), per
  approved plan. Opus subagents for the two design tasks, Sonnet for audit/fixes.
- Hero backdrop (`feat/hero-particle-backdrop`): new `src/app/HeroBackdrop.tsx` — canvas
  2D particle field (34–80 particles by viewport; outlined coral squares, filled ink
  circles, plus-marks; 3 depth tiers with speed/alpha/size scaling; rotation; pointer
  repulsion within 130px; faint ≤118px connective lines). DPR-aware (capped 2),
  ResizeObserver, pauses on `document.hidden` + IntersectionObserver, reduced-motion =
  one static frame with live media-query listener, rafId/running guard vs StrictMode
  double-mount. Mounted last in `.hero`; CSS: `.hero` relative, content z-1, full-bleed
  `.hero-backdrop` z-0 with radial mask edge fade, opted out of the `rise` nth-child rule.
- Dashboard life (`feat/dashboard-life`): new `src/app/dashboard/DashboardBackdrop.tsx`
  (dimmer/sparser echo — ~40% count, ~half alpha, no lines/pointer). `LinkManager.tsx`:
  staggered entrances (topbar → cards → tbody rows), skeleton→content crossfade,
  delete-exit sequencing (`deletingId` + 300ms `row-collapse` on `.cell-inner` before the
  unchanged optimistic delete; error path snaps row back), count-badge pop keyed on
  length, live-pulsing kicker dot, row hover tint + coral inset marker, button polish.
- Audit (Sonnet, read-only): no blockers. Two minors fixed on
  `fix/motion-audit-findings`: `dot-pulse` reworked box-shadow → transform/opacity only;
  all Delete buttons disabled while any row exit is in flight.
- Verified: typecheck clean at every merge; `npx vitest run` 260/260 (30 files); no new
  deps, no console.log, `src/types`/`src/lib` untouched. Live via `next dev`: page 200s,
  zero console errors; DOM/computed-style checks confirm backdrop absolute z-0,
  pointer-events none, mask active, hero content z-1, canvas sized. Pixel screenshots
  blocked — Browser pane hidden this session (`visibilityState: "hidden"`, rAF
  suspended; same stuck-screenshot behavior as prior sessions) — worth an eyeball on the
  running dev server.
- Outcome: three branches merged `--no-ff` to `main`, branches deleted, pushed together
  with this entry.

## 2026-07-14

**v3 plan authored** (`docs/plan-v3`, merged to `main`)
- New `docs/PLAN_V3.md`: scopes v3 as Track Q (severity/ignore rules via a repo-versioned
  `guardrail.config.json`, exact-match `ignore`/`warn` only), Track R (run history —
  `pipeline_runs` migration 0006, fail-open `insertPipelineRun`, dashboard runs API + UI),
  Wave X0 adoption of the v2 §8 Law amendments into CLAUDE.md, and a hard-gated Track S
  (GraphQL SDL — proceeds only if `graphql@^16` is approved as a Law 13 amendment).
- New in this plan: an explicit model/agent policy — Fable (main session) as
  advisor/orchestrator (specs, adversarial design review before each build, wave gates,
  merges, live verification); Sonnet `module-builder` for mechanical tracks (X0, Q2, R1,
  R2); Opus `module-builder` for verdict-affecting/glue tracks (Q1 rules engine, Wave X2
  Track T integration); Opus `spec-auditor` for Wave X3.
- One planned frozen-type edit (`PipelineRunRow` added to `src/types/db.ts`); `rules.ts`
  is a new additive types file. Wave X1 verified file-disjoint on paper.
- Outcome: plan document only — no implementation started. Merged `--no-ff`, branch
  deleted, pushed to `origin/main`.
