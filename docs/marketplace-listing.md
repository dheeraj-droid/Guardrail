# GitHub Marketplace listing — Guardrail (free listing)

Paste-ready copy for each field of the Marketplace listing form
(`https://github.com/marketplace/new`). This is a **free** listing, so no
publisher verification or banking is required — only the Marketplace Developer
Agreement, which you accept in the browser.

---

## Before you start (GitHub prerequisites)

- [ ] The GitHub App is **public** (App settings → *Make public*), owned by your
      user or org.
- [ ] Homepage URL set → `https://guardrail-coral.vercel.app/`
- [ ] Webhook configured (already true).
- [ ] A **logo** (square, min **200×200 px**, PNG/JPG) and at least one
      **screenshot** (min **1200×630 px**; a check-run "failure" screenshot from
      the demo PR is ideal).
- [ ] You are ready to accept the **GitHub Marketplace Developer Agreement**.

---

## Field-by-field

### Listing name
```
Guardrail
```

### Very short description / headline (tagline)
```
Block backend PRs that would silently break your frontend — before they merge.
```

### Categories
- Primary: **Code quality**
- Secondary: **Continuous integration**

### Supported languages
```
TypeScript, JavaScript
```

### Introductory description (1–2 sentences, shown in cards)
```
Guardrail treats your OpenAPI spec as a contract. When a backend PR removes or
type-changes a field, it scans the linked frontend for live usage and fails the
check — with exact file:line locations — before the merge.
```

### Detailed description (Markdown, the listing body)
```markdown
## Catch breaking API changes before they merge

A backend team deletes `phoneNumber` from the `User` schema. Tests pass, the PR
merges, and the frontend breaks in production because a component still reads
`user.phoneNumber`. **Guardrail catches this before merge.**

On every backend PR that changes an OpenAPI spec, Guardrail:

- **Diffs the contract** — detects deleted and type-mutated fields between the
  base and head spec.
- **Scans the frontend** — uses the TypeScript compiler API (property accesses,
  destructuring, and aliases) to find real usage of the changed fields in your
  linked frontend repo. No regex, no guessing.
- **Reports precisely** — posts a pass/fail check run through the GitHub Checks
  API with the exact `file:line` for every break.

### Built for real repos

- **Monorepo-aware** — the frontend can live in the same repo as the backend;
  scanning is scoped to your frontend source directory.
- **Fails open** — Guardrail's own errors conclude the check as *neutral*, never
  as a failure. Its bugs never block your merges.
- **Fast & safe** — acknowledges the webhook in milliseconds, verifies every
  payload with HMAC-SHA256, and fetches source with bounded concurrency.

### Get started in minutes

1. Install Guardrail on your backend and frontend repos.
2. Link them in the self-serve dashboard (pick the OpenAPI spec path and the
   frontend source directory).
3. Open a PR that changes the spec — Guardrail does the rest.
```

### Feature bullets ("What you can do with this app")
```
- Diff OpenAPI specs for deleted and type-mutated fields on every PR
- Find real frontend usage via the TypeScript compiler API — no regex
- Fail or pass PRs through the GitHub Checks API with exact file:line locations
- Link backend and frontend repos from a self-serve dashboard
- Monorepo support with directory-scoped scanning
- Fail-open design: Guardrail's own errors never block a merge
```

### Pricing plan (free)
- Plan name: **Free**
- Price: **$0**
- Plan description:
```
Unlimited public and private repositories. Contract diffing, frontend AST
scanning, and Checks API pass/fail on every pull request — at no cost.
```

---

## Required App permissions (set these in App settings before listing)

| Scope          | Access       | Why |
|----------------|--------------|-----|
| Contents       | Read-only    | Fetch the OpenAPI spec (Contents API) and frontend source (Trees + Blobs). |
| Metadata       | Read-only    | Mandatory baseline. |
| Checks         | Read & write | Create and conclude the check run. |
| Pull requests  | Read & write | (Only if posting summary comments.) |

**Subscribed events:** `pull_request`

---

## Steps to publish (browser)

1. Go to `https://github.com/marketplace/new`.
2. Select the **Guardrail** GitHub App.
3. Fill each field from this document.
4. Add the logo and screenshot.
5. Create the **Free** pricing plan above.
6. Accept the **GitHub Marketplace Developer Agreement**.
7. Submit for listing. Free listings publish without paid-publisher verification;
   GitHub still runs a listing review before it goes live.

> Note: creating the listing, accepting the agreement, and submitting are actions
> you take in the browser under your own account — they can't be done via API/CLI.
