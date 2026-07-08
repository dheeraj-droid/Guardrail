# Guardrail — Deployment & Testing Runbook

Guardrail is a webhook service. To evaluate a real PR it needs three things wired
together: a **GitHub App** (identity + permissions), a **Supabase database** (the
backend↔frontend map), and a **host** running the Next.js app (Vercel below). This guide
takes you from an empty setup to a passing/failing check on a real PR.

Prerequisites: the repo builds locally (`npm install && npm run build` — should end with
`✓ Compiled successfully`), Node ≥ 20, and the `gh` CLI authenticated.

---

## Step 1 — Create the GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Name:** anything (e.g. `guardrail-<you>`).
- **Homepage URL:** anything (e.g. your repo URL).
- **Webhook → Active:** ✓. **Webhook URL:** `https://<your-deployment>/api/webhook/github`
  (you can put a placeholder now and update it after Step 3).
- **Webhook secret:** generate a strong random string and save it — this is
  `GITHUB_WEBHOOK_SECRET`. (`openssl rand -hex 32` works.)
- **Repository permissions:**
  | Permission | Access | Why |
  |---|---|---|
  | Checks | Read and write | Create/conclude the check run (Law 3 — Apps only) |
  | Contents | Read-only | Fetch the OpenAPI spec + frontend source |
  | Pull requests | Read and write | Post the findings comment |
  | Metadata | Read-only | Mandatory default |
- **Subscribe to events:** ✓ **Pull request**.
- **Where can this be installed:** "Only on this account" is fine.
- Click **Create GitHub App**.

Then, on the App's page:
- Note the **App ID** → `GITHUB_APP_ID`.
- **Generate a private key** → downloads a `.pem` → this becomes `GITHUB_APP_PRIVATE_KEY`
  (formatting in Step 3).
- **Install App** (left sidebar) → install on **both** the backend repo *and* the frontend
  repo. One installation must cover both: the same token reads the frontend and writes
  checks to the backend (Law 3). For a monorepo, that's just the one repo.

---

## Step 2 — Set up Supabase

1. Create a project at supabase.com. From **Settings → API** grab:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** key (secret, server-side) → `SUPABASE_SERVICE_ROLE_KEY`
2. Run the migration. **SQL Editor → New query**, paste the contents of
   [`supabase/migrations/0001_project_links.sql`](../supabase/migrations/0001_project_links.sql),
   run it. (Or `supabase db push` with the Supabase CLI.)
3. Get the numeric **repo IDs** (the table keys on IDs, not names):
   ```bash
   gh api repos/OWNER/BACKEND_REPO  --jq .id     # -> backend_repo_id
   gh api repos/OWNER/FRONTEND_REPO --jq .id     # -> frontend_repo_id
   ```
4. Insert one link row (SQL Editor):
   ```sql
   insert into project_links
     (backend_repo_id, frontend_repo_id, openapi_file_path, frontend_src_directory)
   values
     (123456789, 987654321, 'openapi.json', 'src');
   ```
   - `openapi_file_path` — path to the spec in the **backend** repo.
   - `frontend_src_directory` — only files under this prefix in the **frontend** repo are
     scanned (e.g. `src`, or `apps/web/src` for a monorepo).
   - **Monorepo:** set `frontend_repo_id` equal to `backend_repo_id`.

---

## Step 3 — Deploy to Vercel

The repo is already on GitHub. In Vercel: **Add New → Project → Import** this repo. It
auto-detects Next.js; no build settings to change.

Set **Environment Variables** (Project → Settings → Environment Variables) — all seven:

| Variable | Value |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | the secret from Step 1 |
| `GITHUB_APP_ID` | the App ID from Step 1 |
| `GITHUB_APP_PRIVATE_KEY` | the `.pem` contents (see note) |
| `SUPABASE_URL` | from Step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | from Step 2 |
| `SCAN_CONCURRENCY` | `8` (optional; default 8) |
| `MAX_SCAN_FILES` | `2000` (optional; default 2000) |

> **Private key formatting.** `env.ts` un-escapes `\n`, so the most portable form is the
> **whole key on one line with literal `\n`** between the lines:
> `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n...\n-----END RSA PRIVATE KEY-----\n`
> Pasting the real multi-line PEM also works (the un-escape is a no-op then). If auth fails
> with a key error, this is almost always the culprit.

Deploy. Copy the production URL (e.g. `https://guardrail-you.vercel.app`).

> **Scan duration (recommended).** The frontend scan runs *after* the 202 response via
> `after()`, but still inside the function's execution budget. On Vercel the default cap is
> short. For large frontends, add `export const maxDuration = 60;` to
> `src/app/api/webhook/github/route.ts` (it's an allowed route-segment export) and use a
> plan that permits it. `MAX_SCAN_FILES` and `SCAN_CONCURRENCY` are the other levers.

---

## Step 4 — Point the webhook at the deployment

Back in the GitHub App settings, set **Webhook URL** to
`https://<your-deployment>/api/webhook/github` and save.

Sanity check: **App → Advanced → Recent Deliveries**. The `installation` or `ping` event
should show a recent delivery. A `ping` won't be a `pull_request` event, so Guardrail
replies `202 {"queued":false,"reason":"ignored event"}` — that's correct and confirms the
route is reachable and your signature secret matches.

---

## Step 5 — Test end-to-end

You need a spec in the backend and a matching usage in the frontend.

**Fixture setup (once):**
- Backend repo, `openapi.json` on the default branch, containing e.g.:
  ```json
  { "openapi": "3.0.0", "info": { "title": "x", "version": "1" }, "paths": {},
    "components": { "schemas": { "User": { "type": "object", "properties": {
      "phoneNumber": { "type": "string" }, "age": { "type": "integer" } } } } } }
  ```
- Frontend repo, under the `frontend_src_directory`, a file that uses the field, e.g.
  `src/Profile.tsx`: `export const P = ({ user }) => <div>{user.phoneNumber}</div>;`

**The FAILURE path (the headline scenario):**
1. On the backend repo, open a PR that **deletes** `phoneNumber` from `openapi.json`.
2. Within seconds the PR shows a check **“Guardrail Contract Check”** running, then
   concluding **failure**.
3. A PR comment (marked `<!-- guardrail-report -->`) lists the schema change and the exact
   `src/Profile.tsx` line/column where `phoneNumber` is still used.

**The SUCCESS paths:**
- PR that changes the spec in a way the frontend does **not** use → **success** + a comment
  noting unreferenced changes.
- PR that doesn't touch a breaking field → **success**, no frontend scan, no comment.
- Push another commit to the PR branch (`synchronize`) → Guardrail re-runs and **updates
  the same comment** in place.

---

## Debugging

| Symptom | Likely cause / check |
|---|---|
| No check appears on the PR | GitHub App **Recent Deliveries**: did it deliver? what response code? |
| `401` in Recent Deliveries | `GITHUB_WEBHOOK_SECRET` mismatch between GitHub and the host |
| Check concludes **neutral** "repo not registered" | no `project_links` row, or wrong `backend_repo_id` |
| Check concludes **neutral** "OpenAPI spec not found" | `openapi_file_path` wrong, or spec not on the base ref |
| Check concludes **neutral** "Frontend repository unreachable" | App not installed on the frontend repo |
| Check stuck **in_progress** | the `after()` scan errored or timed out — see host logs; consider `maxDuration` |
| Private-key / auth errors in logs | `GITHUB_APP_PRIVATE_KEY` formatting (see Step 3 note) |

**Logs:** the pipeline logs every conclusion and error with a `[guardrail]` prefix — on
Vercel, Project → **Logs** (or `vercel logs <deployment>`). **Iterate fast:** GitHub App →
Advanced → Recent Deliveries → **Redeliver** re-sends a payload without opening a new PR.

---

## Local development

`npm run dev` serves the route at `http://localhost:3000/api/webhook/github`, but the
pipeline makes real GitHub/Supabase calls, so a meaningful local run needs real creds in
`.env` plus a tunnel (e.g. `cloudflared`/`ngrok`) so GitHub can reach you — point the App's
webhook URL at the tunnel. For logic changes, the 127-test suite (`npm test`) already
exercises the full pipeline against fakes, including the end-to-end verdict matrix in
`tests/integration/pipeline.e2e.test.ts` — that's the fast inner loop; the real PR is the
final confirmation.
