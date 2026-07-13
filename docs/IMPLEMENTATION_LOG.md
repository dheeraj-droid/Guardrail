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
