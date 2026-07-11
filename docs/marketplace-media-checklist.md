# Marketplace media checklist — logo, feature card & screenshots

Concrete production checklist for the visual assets the Guardrail Marketplace
listing needs. Pairs with [marketplace-listing.md](marketplace-listing.md).

GitHub's listing has three visual slots: a **logo**, a **feature card**
(logo + background color GitHub composites for you), and up to **five
screenshots**.

---

## 1. Logo

GitHub crops the logo to a circle on some surfaces and shows it square on others,
so keep the mark centered with padding.

- [ ] **Format:** PNG with transparent background (SVG source, exported to PNG).
- [ ] **Dimensions:** square, **min 200×200 px**; produce at **512×512 px** so it
      stays crisp on retina cards.
- [ ] **Safe zone:** keep the mark inside the centered ~80% — leave ~10% padding
      on every side so a circular crop doesn't clip it.
- [ ] **Mark:** a shield/guard glyph fits the name; single-color or two-tone reads
      better at small sizes than a detailed illustration.
- [ ] **No text** in the logo itself — the listing shows the name beside it.
- [ ] **Test small:** downscale to 40×40 and confirm it's still legible.

## 2. Feature card background color

GitHub builds the top "hero" card from your logo on a solid background you pick.

- [ ] Choose a **background hex** with strong contrast against the logo.
- [ ] Match the product/site accent (the deployment is at
      `guardrail-coral.vercel.app` — a coral/red or a deep slate both work).
- [ ] Verify **logo-on-background contrast** ≥ 3:1 so the mark doesn't wash out.

## 3. Screenshots (the part that sells it)

GitHub shows these in a carousel. Lead with the "aha": a **failing check run with
file:line locations**. Up to 5.

- [ ] **Format:** PNG.
- [ ] **Dimensions:** **min 1200 px wide**; **1200×630 px** (1.91:1) is the sweet
      spot GitHub renders cleanly. Keep all five the **same size**.
- [ ] **Retina:** capture on a 2× display or a 2400-px-wide window, then export —
      avoids blur.
- [ ] **Crop out chrome:** no OS taskbar, no browser bookmarks bar, no personal
      tabs/avatars. A clean window or a framed screenshot only.
- [ ] **Redact:** no real tokens, private repo names, or emails visible.

### Recommended shot list (in carousel order)

1. [ ] **The failing check** — GitHub PR "Checks" tab showing Guardrail's
       `failure` conclusion with the summary listing `file:line` for each break
       (e.g. the demo PR that removed `phoneNumber` and mutated `age`).
2. [ ] **The check detail / annotations** — the expanded check output or inline
       annotation pointing at the exact frontend line, including the destructuring
       alias case.
3. [ ] **A passing check** — a spec change with no frontend impact concluding
       `success`, to show it's not noisy.
4. [ ] **The dashboard** — the self-serve link screen where a backend repo is
       linked to a frontend repo with the spec path + source directory fields.
5. [ ] *(optional)* **The flow diagram** — the "How it works" pipeline from the
       README as a clean graphic, for reviewers who skim.

### Capturing shots 1–3

- Use the live demo: a PR on
  [guardrail-demo](https://github.com/dheeraj-droid/guardrail-demo) against the
  deployment at `guardrail-coral.vercel.app`.
- Wait for the check run to finish, open the **Checks** tab, expand Guardrail,
  and capture at ~1280 px window width.

### Verified capture recipe (everything below is live as of this writing)

The demo PR and its failing check already exist and are publicly viewable — no
sign-in needed to see them. Capture in a browser at ~1280 px width, then crop.

- **Shot 1 & 2 — the failing check (hero):**
  <https://github.com/dheeraj-droid/guardrail-demo/pull/1/checks?check_run_id=86213018322>
  The check detail reads, verbatim:
  > **Guardrail Contract Check** — failed in 3s
  > 4 broken frontend reference(s) to 2 schema change(s)
  >
  > Found 4 frontend reference(s) to 2 breaking schema change(s). Merge is blocked
  > until the frontend references are removed or the schema change is reverted.

  Capture the whole check panel (status + summary). For shot 2, scroll to the
  detailed `file:line` breakdown lower in the summary and capture that. Frame so
  the red ✗ "Failing" status and the `guardrail-app` author are both visible.
- **Shot 4 — the dashboard:** <https://guardrail-coral.vercel.app/> (sign in with
  GitHub to reach the link-management screen; capture the repo-link form with the
  spec path + source-directory fields).
- **Shot 3 — a passing check:** push a spec change with no frontend impact to a new
  demo PR and capture the green `success` check. (Optional but reassuring.)

> Note: automated capture from this session's browser timed out (GitHub's checks
> view holds a live connection open, and the sandbox screenshot tool hangs waiting
> for idle). The pages themselves are confirmed live and correct — capture them
> from your own browser; it takes about two minutes.

---

## Final pre-upload gate

- [ ] Logo exported at 512×512 PNG, transparent, legible at 40 px.
- [ ] Background hex chosen and contrast-checked.
- [ ] 3–5 screenshots, all identical size, ≥1200 px wide, no chrome, nothing
      sensitive on screen.
- [ ] Screenshot #1 is the failing check with file:line — the strongest frame.
