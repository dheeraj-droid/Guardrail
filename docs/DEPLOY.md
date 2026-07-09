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

> **Private key format — the #1 gotcha (two parts).**
>
> **1. It must be PKCS#8.** GitHub downloads the key in **PKCS#1**
> (`-----BEGIN RSA PRIVATE KEY-----`), but octokit v4 signs the App JWT with Web Crypto,
> which only accepts **PKCS#8** (`-----BEGIN PRIVATE KEY-----`). A PKCS#1 key fails at
> runtime with `[guardrail] failed to start check run: Invalid keyData`
> (`DataError: Invalid keyData`) — and, per fail-open, produces **no check run at all**.
> Convert it once:
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
> ```
> The result begins `-----BEGIN PRIVATE KEY-----` (no "RSA").
>
> **2. Escape the newlines.** `env.ts` un-escapes `\n`, so store the PKCS#8 key on one line
> with literal `\n` between lines:
> ```bash
> awk 'NF {printf "%s\\n", $0}' app.pkcs8.pem   # copy this as GITHUB_APP_PRIVATE_KEY
> ```
> (Pasting the real multi-line PEM also works — the un-escape is then a no-op.) After
> changing the env var, **redeploy** so it takes effect.

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

## Step 6 — enable the public dashboard

Optional. The webhook pipeline (Steps 1-5) works without any of this — it's only needed if
you want a web UI for signing in with GitHub and managing `project_links` rows instead of
inserting them by hand in Supabase.

1. **Make the GitHub App public.** App settings → scroll to the visibility section → set
   it to **Public** (anyone can install it; only users you authorize can still write link
   rows — see `authorizeLink` in `src/lib/auth/authorize.ts`).
2. **Set the callback URL.** App settings → **Identifying and authorizing users** →
   **Callback URL** → `<APP_BASE_URL>/api/auth/callback` (e.g.
   `https://guardrail-xyz.vercel.app/api/auth/callback`). Also enable **Request user
   authorization (OAuth) during installation** if you want new installs to prompt sign-in
   immediately.
3. **Generate a client secret.** Same settings page → **Generate a new client secret** →
   copy it immediately (shown once) → this is `GITHUB_APP_CLIENT_SECRET`. The **Client ID**
   on the same page is `GITHUB_APP_CLIENT_ID`.
4. **Note the App slug.** The URL of the App's public page is
   `https://github.com/apps/<slug>` — that `<slug>` is `GITHUB_APP_SLUG` (used to build the
   "Install the GitHub App" link on the landing page).
5. **Run migration 0002.** SQL Editor → New query → paste
   [`supabase/migrations/0002_link_ownership.sql`](../supabase/migrations/0002_link_ownership.sql)
   → run it. It only adds nullable columns (`created_by_github_id`, `created_by_login`,
   `updated_at`) — existing rows and the pipeline's frozen `ProjectLink` type are
   unaffected.
6. **Set the five new env vars** (Vercel → Project → Settings → Environment Variables),
   then **redeploy**:

   | Variable | Value |
   |---|---|
   | `GITHUB_APP_CLIENT_ID` | from step 3 |
   | `GITHUB_APP_CLIENT_SECRET` | from step 3 |
   | `GITHUB_APP_SLUG` | from step 4 |
   | `GUARDRAIL_SESSION_SECRET` | a random string >= 32 chars, e.g. `openssl rand -hex 32` |
   | `APP_BASE_URL` | your deployment URL, no trailing slash |

Visit `APP_BASE_URL` — you should see the landing page with "Install the GitHub App" and
"Sign in with GitHub" buttons. Sign in, then link a backend/frontend repo pair from the
`/dashboard` UI (only repos where the App is installed AND you have admin/maintain access
are selectable as a *backend*; any accessible repo can be a *frontend*). The GitHub user
token never reaches the browser — it lives only in an encrypted, HttpOnly session cookie
server-side (`src/lib/auth/session.ts`).

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
| Log: `failed to start check run: Invalid keyData` (+ no check run) | `GITHUB_APP_PRIVATE_KEY` is PKCS#1 — convert to PKCS#8, or fix `\n` escaping (Step 3 note) |

**Logs:** the pipeline logs every conclusion and error with a `[guardrail]` prefix — on
Vercel, Project → **Logs** (or `vercel logs <deployment>`). **Iterate fast:** GitHub App →
Advanced → Recent Deliveries → **Redeliver** re-sends a payload without opening a new PR.

---

## Local development

`npm run dev` serves the route at `http://localhost:3000/api/webhook/github`, but the
pipeline makes real GitHub/Supabase calls, so a meaningful local run needs real creds in
`.env` plus a tunnel (e.g. `cloudflared`/`ngrok`) so GitHub can reach you — point the App's
webhook URL at the tunnel. For logic changes, the 180-test suite (`npm test`) already
exercises the full pipeline against fakes, including the end-to-end verdict matrix in
`tests/integration/pipeline.e2e.test.ts` — that's the fast inner loop; the real PR is the
final confirmation.
