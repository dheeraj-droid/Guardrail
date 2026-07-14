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
3. **The hero has motion but no life.** (Direction updated 2026-07-14 after user
   feedback: "inspire from Apple design language — ambitious and pristine yet minimal,
   without slop.") A field of autonomously drifting particles is decoration the user
   can't touch — Apple-grade "life" comes from *response* (the page reacts to you,
   instantly and 1:1), *choreography* (one composed entrance that settles), and *one
   ambitious signature element* — never from looping ambient confetti. The current
   particle field is replaced, not tuned.

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

## Task 4 — Apple-grade hero (branch `feat/hero-apple-life`, Opus)

Files: `src/app/HeroBackdrop.tsx` (full rewrite, may rename), `src/app/page.tsx`
(hero markup/typography), `src/app/globals.css`. Read
`.claude/skills/apple-design/SKILL.md` FIRST — this task implements its principles.
No new deps (Law 13): springs are hand-rolled rAF (critically damped is ~6 lines),
not Framer Motion.

Life = response + choreography + one signature element. Not ambient confetti.

1. **Replace the drifting particle field with a responsive dot lattice.** Canvas
   draws a fine, static grid of dots (~24px cell, ink at ~4–5% alpha) across the hero
   — structured, pristine, invisible until you move. A soft spotlight (~180–240px
   radius) follows the pointer: dots inside it brighten toward `--accent` and scale
   up slightly (≤1.6×), with smooth radial falloff. The spotlight position is driven
   by a critically damped spring (damping 1.0, response ~0.35s) so it glides — but
   updates start the same frame the pointer moves (respond on input, kill latency).
   No autonomous motion at rest except at most ONE idle element (see 3). Touch
   devices: spotlight follows touch during scroll-overs or is simply absent — never
   fake a wandering cursor.
2. **Choreographed entrance, runs once.** Kicker → headline → lede → CTAs → visual,
   each rising ~12px with opacity, spring-like ease (`cubic-bezier(0.22, 1, 0.36, 1)`),
   ~70ms stagger. The lattice fades in last, underneath. Nothing loops afterward;
   the page settles. Entrance must not lock out input (interruptibility: content is
   clickable immediately).
3. **One signature ambitious element (choose ONE, keep the rest quiet):** the
   recommended pick is a slow "contract scan" beam — a ~full-width, very soft coral
   gradient band that sweeps the lattice once on load (after the entrance) and then
   only on pointer re-entry into the hero, echoing what Guardrail does (scanning
   contracts). Alternative if the beam prototypes poorly: pointer-parallax on the
   hero art (≤6px translation, spring-damped). Not both.
4. **Pristine typography (Apple §15).** Headline: `clamp()` display size, line-height
   ~1.05, letter-spacing `-0.02em`, build hierarchy with weight — check the current
   values and correct any fixed/positive tracking on display text. Body/lede stays
   near tracking 0, leading ~1.5.
5. **Material chrome (Apple §12).** Topbar becomes a translucent layer:
   `rgba(255,255,255,0.72)` + `backdrop-filter: blur(20px) saturate(180%)`, hard 1px
   bottom border replaced by a scroll edge effect (border/shadow fades in only once
   content has scrolled under it). Honor `prefers-reduced-transparency` (solid bg,
   no blur).
6. **Press feedback everywhere in the hero:** CTAs scale to 0.97 on `:active` with a
   ~100ms ease-out — feedback on pointer-down, not release.
7. **Reduced motion:** lattice renders static (no spotlight tracking, or opacity-only
   highlight), no entrance translation (opacity cross-fade only), no beam sweep.

Acceptance: at rest the hero is nearly still and pristine; moving the pointer makes
it feel alive with zero perceptible latency; entrance plays once and settles; exactly
one signature motion element exists; typography passes the §15 checks; typecheck
passes; reduced-motion/transparency verified via emulation.

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
- Hero: still and pristine at rest; responsive dot lattice + spotlight under the
  pointer; one-shot choreographed entrance; exactly one signature motion element;
  Apple-grade typography and translucent chrome.
- All gates green (typecheck, 260 tests), reduced-motion clean, no new deps, log
  updated, pushed, and verified on the production deployment.
