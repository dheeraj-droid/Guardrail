# Premium Polish Plan — Dashboard surfaces + Hero particle tuning

Status: NOT STARTED. Written 2026-07-14 after user review of the deployed dashboard
(guardrail-coral.vercel.app/dashboard) — verdict: "doesn't look premium".

## Diagnosis (why the current UI fails the bar)

1. **Floating particles over light content read as dirt.** `DashboardBackdrop.tsx`
   scatters low-alpha gray/coral shapes across the content zone. On a flat white page
   they look like smudges/rendering artifacts, not ambience. Premium light-theme
   products (Linear, Vercel, Stripe) use *structured* ambience — gradient washes
   anchored to an edge, dot-grids confined to a band — never free-floating shapes over
   content.
2. **The page is white-on-white.** Page bg, cards, and table are all `#ffffff` with 1px
   outlines. No surface hierarchy = no depth = "flat and cheap" regardless of motion.
3. **The hero canvas is right in concept, mistuned in execution.** Particles sit behind
   the headline at gray-mud alpha instead of being pushed to the periphery with clear
   coral intent.

Keep (these worked): staggered entrances, delete-row exit animation, count-badge pop,
pulsing kicker dot, skeleton crossfade, all reduced-motion handling.

## Execution rules

- One git branch per task, Conventional-Commits name, merge `--no-ff` to main, delete
  branch, push at the end (CLAUDE.md Law 16). Never commit on main directly.
- Design-heavy tasks (1, 2, 4) → **Opus** subagents. Mechanical tasks (3, parts of 5) →
  **Sonnet** subagents. Orchestrator gates every merge with `npm run typecheck`; run
  `npx vitest run` (must stay 260/260) before the final push.
- No new npm dependencies (Law 13). No console.log. Transform/opacity-only animations
  (existing sanctioned exception: `row-collapse` on `.cell-inner`). Every new
  animation neutralized in the `prefers-reduced-motion` blocks (globals.css ~1494 and
  ~1851).
- Design tokens live in `:root` of `src/app/globals.css`: `--bg #ffffff`,
  `--bg-soft #f7f7f5`, `--ink #17181c`, `--accent #e9564a`, `--accent-deep #c93a2e`.
  Extend tokens; don't hardcode new hex values inline.

## Task 1 — Dashboard surface depth (branch `feat/dashboard-surfaces`, Opus)

Files: `src/app/dashboard/LinkManager.tsx`, `src/app/globals.css`,
DELETE `src/app/dashboard/DashboardBackdrop.tsx`.

1. Remove `<DashboardBackdrop />` mount, the import, the component file, and all
   `.dashboard-backdrop` CSS (including its reduced-motion entries and the
   `.dashboard > *` z-index scaffolding if nothing else needs it).
2. Dashboard page background becomes `--bg-soft` (scope it — e.g. a `.dashboard-page`
   wrapper or `body:has(.dashboard)` — do NOT change the landing page background).
3. Cards become elevated true-white surfaces: `background: var(--bg)`, refined 1px
   border (slightly darker than current), radius ~10–12px, layered shadow (e.g.
   `0 1px 2px rgb(23 24 28 / 0.04), 0 8px 24px -12px rgb(23 24 28 / 0.10)`), and a
   slightly stronger hover shadow on interactive cards only if it doesn't fight the
   entrance stagger.
4. Keep every existing dashboard animation listed under "Keep" above.

Acceptance: dashboard shows clear page-vs-card contrast; zero canvas elements on the
dashboard; typecheck passes.

## Task 2 — Structured header ambience (branch `feat/dashboard-header-band`, Opus)

Files: `src/app/globals.css`, `src/app/dashboard/LinkManager.tsx` (markup only if a
wrapper element is needed).

CSS-only ambience confined to the top band of the dashboard (from page top to just
above the first card):

1. A soft coral gradient wash bleeding from the top edge — radial or conic from
   top-left, `--accent` at ~4–6% alpha fading to transparent within ~320px of the top.
2. A fine dot-grid texture (`radial-gradient(circle, ...)` background-image, ~18–22px
   cell, ink at ~5% alpha) masked with a vertical fade so it dissolves BEFORE the first
   card. The grid must sit behind the topbar text (z-order) and never tile over cards.
3. Static by default. At most one slow ambient drift on the wash (transform/opacity
   only); skip entirely under reduced motion.

Acceptance: ambience clearly "belongs" to the header band; nothing floats over cards
or table; screenshot at 1280px and 375px shows no banding/clipping artifacts.

## Task 3 — Table + micro polish (branch `feat/dashboard-table-polish`, Sonnet)

Files: `src/app/globals.css` only (markup untouched unless a class is missing).

1. Row rhythm: consistent vertical padding via `.cell-inner`, hairline row separators
   (`--ink` at ~6–8%), header row in current all-caps style but slightly dimmer.
2. Hover: current tint + coral inset marker stays; verify it composes with the new
   card surface (no double-borders).
3. Buttons: ensure `button-danger` (Delete) matches the elevated-surface look — quiet
   at rest (ghost/outline), decisive on hover.
4. Form fields: verify `focus-visible` rings exist and use `--accent` at readable
   contrast on the new white cards.

Acceptance: typecheck passes; visual pass at both viewports; delete-exit and
row-entrance animations still play.

## Task 4 — Hero particle tuning (branch `feat/hero-particle-tuning`, Opus)

File: `src/app/HeroBackdrop.tsx` (constants + draw logic only), `src/app/globals.css`
(mask only if needed).

1. **Center avoidance**: weight particle home positions toward the periphery — e.g.
   rejection-sample spawns so density within the central headline column (~54rem,
   vertically the title/lede zone) is ≤ 1/3 of edge density, or add a center-out
   density falloff. Particles may drift through the center but must not cluster there.
2. **Color intent**: shift the mix toward coral — ink shapes drop to the far tier
   only; near/mid tiers use `--accent`/`--accent-deep`. Raise near-tier alpha slightly
   (≤ 0.22) so the field reads as deliberate color, not gray mud.
3. Keep count/speed/repulsion as-is unless testing shows otherwise; all tuning stays
   in the named constants at the top of the file.
4. Reduced-motion static frame must respect the same density weighting.

Acceptance: at 1280px the headline zone is visibly calmer than the edges; particles
read coral-on-white; typecheck passes.

## Task 5 — Verification + log + ship (orchestrator, Sonnet for mechanical parts)

1. `npm run typecheck` clean; `npx vitest run` 260/260.
2. Launch `guardrail-dev` via preview (`.claude/launch.json`), with the Browser pane
   VISIBLE — prior sessions: hidden pane ⇒ rAF suspended ⇒ screenshots hang. Capture
   screenshots: hero (desktop + mobile), dashboard signed-out redirect, and — since
   the signed-in dashboard needs GitHub OAuth — verify dashboard styling by
   temporarily viewing the LinkManager DOM is NOT possible locally; instead deploy and
   click through production (user has a session at guardrail-coral.vercel.app).
3. Append a terse entry to `docs/IMPLEMENTATION_LOG.md` (docs/ branch, Law 16).
4. Merge all branches `--no-ff`, delete branches, push `origin/main`, confirm the
   Vercel deployment picks it up, then ask the user to eyeball
   guardrail-coral.vercel.app/dashboard against the Diagnosis section above.

## Definition of done

- Dashboard: zero floating particles; soft-gray page / white elevated cards; header
  band ambience; polished table; all kept animations intact.
- Hero: periphery-weighted coral particle field, calm headline zone.
- All gates green (typecheck, 260 tests), reduced-motion clean, no new deps, log
  updated, pushed, and verified on the production deployment.
