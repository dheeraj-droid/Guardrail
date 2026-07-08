# Spec K — Public Onboarding Dashboard (Wave 4)

**Wave:** 4 (solo — the whole feature is one track, one agent)
**Agent:** module-builder (sonnet) | **Depends on:** everything shipped through Wave 3
**Mission:** make Guardrail usable by ANY GitHub user: install the App → sign in with
GitHub → pick backend/frontend repos from a list → create/edit/delete their
`project_links` rows in a web UI. No SQL, no numeric repo IDs, no operator involvement.

This feature is SECURITY-SENSITIVE. Strangers authenticate and write rows that control
check behavior on their repos. Every rule below marked MUST is load-bearing; do not
soften any of them.

## Files produced / edited

| # | File | Action |
|---|---|---|
| 1 | `supabase/migrations/0002_link_ownership.sql` | new |
| 2 | `src/config/env.ts` | EDIT — add `DashboardEnv` + `loadDashboardEnv()` (authorized exception to the frozen-W0 rule; do NOT touch `Env`/`loadEnv`) |
| 3 | `src/lib/auth/session.ts` | new (pure crypto) |
| 4 | `src/lib/auth/oauth.ts` | new |
| 5 | `src/lib/auth/authorize.ts` | new (pure) |
| 6 | `src/lib/github/client.ts` | EDIT — add `getUserClient` (client.ts stays the ONLY Octokit construction site, Law 3) |
| 7 | `src/lib/github/userRepos.ts` | new |
| 8 | `src/lib/db/linkAdmin.ts` | new |
| 9 | `src/app/layout.tsx`, `src/app/globals.css` | new |
| 10 | `src/app/page.tsx` | new — landing page |
| 11 | `src/app/dashboard/page.tsx` | new — server component shell |
| 12 | `src/app/dashboard/LinkManager.tsx` | new — `'use client'` component |
| 13 | `src/app/api/auth/login/route.ts` | new |
| 14 | `src/app/api/auth/callback/route.ts` | new |
| 15 | `src/app/api/auth/logout/route.ts` | new |
| 16 | `src/app/api/dashboard/repos/route.ts` | new |
| 17 | `src/app/api/links/route.ts` | new (GET/POST/DELETE) |
| 18 | `.env.example`, `docs/DEPLOY.md`, `README.md` | EDIT — document the five new env vars + public-app setup |
| Tests | `tests/auth/session.test.ts`, `tests/auth/oauth.test.ts`, `tests/auth/authorize.test.ts`, `tests/github/userRepos.test.ts`, `tests/db/linkAdmin.test.ts`, `tests/dashboard/linksRoute.test.ts` | new |

REMINDER (route-file law, learned in production): a `route.ts` may export ONLY HTTP
handlers + segment config. ALL helpers (session reading, handler factories for tests)
live in sibling non-route files. Every auth/dashboard route sets
`export const runtime = 'nodejs'` (node:crypto).

## New environment variables (validated in `loadDashboardEnv()` ONLY)

```
GITHUB_APP_CLIENT_ID       # from the GitHub App settings page
GITHUB_APP_CLIENT_SECRET   # generated there
GITHUB_APP_SLUG            # e.g. "guardrail-dheeraj" -> install URL
GUARDRAIL_SESSION_SECRET   # >= 32 chars; cookie encryption key material
APP_BASE_URL               # e.g. https://guardrail-xyz.vercel.app (no trailing slash)
```

```ts
export interface DashboardEnv {
  clientId: string; clientSecret: string; appSlug: string;
  sessionSecret: string; baseUrl: string;
}
export function loadDashboardEnv(source?: NodeJS.ProcessEnv): DashboardEnv;
```
Same pattern as `loadEnv` (memo on process.env, stub bypasses memo, throw naming the
FIRST missing var). Additional rules: `sessionSecret.length >= 32` else throw
`'GUARDRAIL_SESSION_SECRET must be at least 32 characters'`; strip a trailing `/` from
`baseUrl`. MUST NOT add these to `loadEnv()`/`Env` — the webhook pipeline must keep
working on deployments that never configure the dashboard.

## 1 — Migration `0002_link_ownership.sql`

```sql
-- Dashboard ownership metadata (Spec K). Nullable on purpose: rows inserted manually
-- (v1 era) remain valid; the pipeline's frozen ProjectLink type does not know these
-- columns and must not need to.
ALTER TABLE project_links
  ADD COLUMN IF NOT EXISTS created_by_github_id BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_login VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
```
Do NOT alter existing columns. Do NOT touch `src/types/db.ts` (Law 1) — dashboard code
uses a LOCAL type `ProjectLinkRow = ProjectLink & { created_by_login?: string | null }`.

## 2 — `src/lib/auth/session.ts` (pure: node:crypto only, no env, no IO)

```ts
export interface SessionData {
  token: string;      // GitHub user-to-server access token. NEVER sent to the browser in
                      // any other form, NEVER logged.
  login: string;
  userId: number;
  expiresAt: number;  // epoch ms
}
export const SESSION_COOKIE = 'guardrail_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

export function sealSession(data: SessionData, secret: string): string;
export function unsealSession(value: string | null | undefined, secret: string, now?: number): SessionData | null;
```
- Key = `createHash('sha256').update(secret).digest()` (32 bytes). Cipher =
  `aes-256-gcm`, random 12-byte IV per seal (`randomBytes`).
- Wire format: `base64url(iv) + '.' + base64url(ciphertext) + '.' + base64url(authTag)`.
- `unsealSession` returns `null` (NEVER throws) for: null/undefined/empty input, wrong
  part count, base64 garbage, auth-tag failure (tampering), JSON parse failure, missing
  fields, or `expiresAt <= now` (default `now = Date.now()`).

## 3 — `src/lib/auth/oauth.ts`

```ts
export const STATE_COOKIE = 'guardrail_oauth_state';

export function buildAuthorizeUrl(opts: { clientId: string; baseUrl: string; state: string }): string;
// -> https://github.com/login/oauth/authorize?client_id=...&redirect_uri=<baseUrl>/api/auth/callback&state=...
// URL-encode params. GitHub App user auth ignores OAuth scopes — do NOT send a scope param.

export function generateState(): string; // 32 hex chars via node:crypto randomBytes

export async function exchangeCodeForToken(opts: {
  clientId: string; clientSecret: string; code: string;
  fetchImpl?: typeof fetch;             // injection seam for tests; default globalThis.fetch
}): Promise<string>;
// POST https://github.com/login/oauth/access_token, JSON body {client_id, client_secret, code},
// header Accept: application/json. Response JSON has access_token (string) on success or an
// `error` field. Missing/empty access_token -> throw Error('OAuth code exchange failed: <error|unknown>').
// This is the ONE sanctioned non-Octokit HTTP call (github.com endpoint is not the REST API).

export async function fetchViewer(octokit: Octokit): Promise<{ login: string; id: number }>;
// GET /user via octokit.request
```

## 4 — `src/lib/auth/authorize.ts` (PURE — the authorization law lives here, testable)

```ts
export interface RepoAccess {
  id: number;
  fullName: string;          // "owner/name"
  canAdminister: boolean;    // permissions.admin === true || permissions.maintain === true
}
export type AuthzResult =
  | { ok: true; backend: RepoAccess; frontend: RepoAccess }
  | { ok: false; status: 403 | 404; reason: string };

export function authorizeLink(opts: {
  backendRepoId: number;
  frontendRepoId: number;
  accessible: readonly RepoAccess[];   // from listAccessibleRepos (user token)
}): AuthzResult;
```
Rules (exact, in order):
1. backend not in `accessible` → `{ok:false, status:404, reason:'backend repository not
   found in your app installations'}` (404, not 403 — do not leak that the repo exists).
2. backend found but `!canAdminister` → `{ok:false, status:403, reason:'you need admin or
   maintain permission on the backend repository'}`.
3. frontend not in `accessible` → `{ok:false, status:404, reason:'frontend repository not
   found in your app installations'}` (App must cover it or the pipeline could never scan it).
4. Monorepo (`backendRepoId === frontendRepoId`) is VALID (Law 8) — rules 1–2 then cover it.
5. Otherwise ok.

## 5 — `src/lib/github/client.ts` (EDIT — add, change nothing existing)

```ts
/** Octokit acting AS THE SIGNED-IN USER (dashboard only — never the pipeline). */
export function getUserClient(token: string): Octokit; // new Octokit({ auth: token })
```

## 6 — `src/lib/github/userRepos.ts` (adapter; `octokit.request` only, like Track E)

```ts
export interface AccessibleRepo {
  id: number; fullName: string; owner: string; name: string;
  canAdminister: boolean; installationId: number;
}
export async function listAccessibleRepos(octokit: Octokit): Promise<AccessibleRepo[]>;
```
- `GET /user/installations` (per_page 100, first page — v1) → for each installation:
  `GET /user/installations/{installation_id}/repositories` (per_page 100, first page).
  These endpoints return ONLY repos where the App is installed AND the user has access —
  that intersection is the security primitive of this feature.
- Map: `canAdminister = permissions.admin === true || permissions.maintain === true`
  (tolerate missing `permissions` → false). Dedupe by repo id (keep first).
- Helper for routes: `export function toRepoAccess(r: AccessibleRepo): RepoAccess`.

## 7 — `src/lib/db/linkAdmin.ts` (service-role db, injected like projectLinks.ts)

```ts
import type { ProjectLink } from '@/types/db';
export type ProjectLinkRow = ProjectLink & { created_by_login?: string | null };

export async function listLinksForRepoIds(db: SupabaseClient, backendRepoIds: readonly number[]): Promise<ProjectLinkRow[]>;
// .from('project_links').select('*').in('backend_repo_id', [...ids]); [] input -> [] without querying.

export async function upsertProjectLink(db: SupabaseClient, row: {
  backend_repo_id: number; frontend_repo_id: number;
  openapi_file_path: string; frontend_src_directory: string;
  created_by_github_id: number; created_by_login: string;
}): Promise<void>;
// .upsert({...row, updated_at: new Date().toISOString()}, { onConflict: 'backend_repo_id' })

export async function deleteProjectLink(db: SupabaseClient, backendRepoId: number): Promise<void>;
```
All three: `error` truthy → throw `Error('project_links <op> failed: ' + error.message)`.

## 8 — HTTP layer

Shared helper `src/app/api/_lib/requireSession.ts` (NOT a route file):
```ts
export interface DashboardContext { session: SessionData; env: DashboardEnv; }
export function readSession(req: Request, env: DashboardEnv): SessionData | null; // parse Cookie header, unseal
export function requireSession(req: Request, env: DashboardEnv): DashboardContext | Response; // 401 JSON when absent
export function requireCsrf(req: Request): Response | null;
// mutating requests MUST carry header `x-guardrail-request: dashboard`; else 403 JSON.
export function buildDashboardDeps(): { env: DashboardEnv; db: SupabaseClient };
// loadDashboardEnv() + createDbClient(loadEnv()) — lazy, never at module top level.
```
Cookie writing: `Set-Cookie` header string: `guardrail_session=<sealed>; Path=/; HttpOnly;
Secure; SameSite=Lax; Max-Age=28800`. Clearing: same with empty value + `Max-Age=0`.

**Routes** (each `route.ts` exports only handlers + `runtime`; logic in `_lib` or inline
minimal; every handler wrapped so unexpected errors → 500 JSON `{error:'internal error'}`
with `console.error('[guardrail-dash] ...')` — no stack/token leakage in responses):

- `GET /api/auth/login` — `state = generateState()`; set STATE_COOKIE (HttpOnly, Secure,
  Lax, Max-Age=600); 302 to `buildAuthorizeUrl(...)`.
- `GET /api/auth/callback?code&state` — MUST: state param present AND equals STATE_COOKIE
  value else 403; clear state cookie in the response either way. Exchange code → token;
  `fetchViewer(getUserClient(token))`; seal `{token, login, userId, expiresAt: Date.now()+SESSION_TTL_MS}`;
  set session cookie; 302 → `/dashboard`. Exchange/viewer failure → 302 → `/?error=auth`
  (never a 5xx with details).
- `POST /api/auth/logout` — requireCsrf; clear session cookie; 204.
- `GET /api/dashboard/repos` — requireSession; `listAccessibleRepos(getUserClient(session.token))`;
  200 `{ repos: AccessibleRepo[] }`.
- `GET /api/links` — requireSession; accessible = listAccessibleRepos(...);
  `listLinksForRepoIds(db, accessible.map(r => r.id))`; 200 `{ links: ProjectLinkRow[] }`
  (a user only ever sees links for repos they can access).
- `POST /api/links` — requireSession + requireCsrf. Body JSON:
  `{ backendRepoId, frontendRepoId, openapiFilePath?, frontendSrcDirectory? }`.
  Validation (400 on failure): both ids finite positive integers; paths after `trim()`:
  default `'openapi.json'` / `'src'` when absent/empty, length <= 255, MUST NOT start with
  `/`, MUST NOT contain `..` or `\`. Then re-fetch accessible repos with the SESSION token
  and run `authorizeLink` — NEVER trust ids from the client (respond with its
  status/reason on failure). On ok: `upsertProjectLink` with `created_by_github_id:
  session.userId, created_by_login: session.login`; 200 `{ link: {...} }`.
- `DELETE /api/links?backendRepoId=N` — requireSession + requireCsrf; id validation;
  authorizeLink with `frontendRepoId = backendRepoId` (delete needs only backend admin);
  `deleteProjectLink`; 204.

## 9 — UI (server components + one client component; plain CSS, no UI deps)

- `layout.tsx`: html/body, loads `globals.css`, header bar "Guardrail" linking `/`.
- `globals.css`: minimal clean styling (system font stack, max-width 960px container,
  simple card/table/button/input styles, visible focus states). No frameworks (Law 13).
- `page.tsx` (landing, server component): headline + 3-step "how it works" (install app →
  sign in → link repos); buttons: "Install the GitHub App" →
  `https://github.com/apps/${loadDashboardEnv().appSlug}/installations/new` and "Sign in
  with GitHub" → `/api/auth/login`. If `?error=auth` is present show a sign-in-failed
  note. MUST NOT throw when dashboard env is unset: wrap `loadDashboardEnv()` in
  try/catch and render a "dashboard not configured" note instead (webhook-only deploys
  stay healthy).
- `dashboard/page.tsx` (server component): read session via `cookies()` from
  `next/headers` + `unsealSession`; no session → `redirect('/')`. Renders
  `<LinkManager login={session.login} />` — the page passes NO token to the client.
- `dashboard/LinkManager.tsx` (`'use client'`): on mount fetch `/api/dashboard/repos` and
  `/api/links` (include header `x-guardrail-request: dashboard` on ALL fetches). UI:
  - table of existing links: backend fullName (resolve id→name from repos list; fall back
    to the raw id), frontend fullName, spec path, src dir, Delete button.
  - "create/update link" form: backend select (only repos with `canAdminister`), frontend
    select (all accessible), "monorepo (same repo)" checkbox that mirrors backend into
    frontend and disables the frontend select, text inputs for spec path (placeholder
    openapi.json) + src dir (placeholder src), submit → POST, then re-fetch links.
  - render API error `reason` strings inline; loading + empty states; logout button →
    POST /api/auth/logout then `location.href = '/'`.
  Keep it plain React state — no data libraries.

## 10 — Acceptance tests (mock octokit as `{ request: vi.fn() }`; db as chainable stub;
routes invoked directly with `new Request(...)`; NO network, NO real cookies needed beyond
header strings)

session: 1 round-trip seal→unseal; 2 tampered ciphertext/authTag → null; 3 expired → null;
4 garbage/empty/null → null; 5 different IV per seal (two seals of same data differ).
oauth: 6 authorize URL exact shape (encoded redirect_uri, state, no scope); 7 exchange
happy path (fetchImpl stub) returns token; 8 exchange error payload → throws; 9 fetchViewer maps login/id.
authorize: 10 backend absent → 404; 11 backend without admin/maintain → 403; 12 frontend
absent → 404; 13 monorepo with admin → ok; 14 cross-repo happy → ok carries both RepoAccess.
userRepos: 15 two installations dedupe + permission mapping (admin true / maintain true /
neither); 16 missing permissions object → canAdminister false.
linkAdmin: 17 upsert called with onConflict backend_repo_id + ownership fields; 18 error
→ throws; 19 listLinksForRepoIds([]) → [] with zero db calls; 20 delete happy path.
linksRoute: 21 GET without session cookie → 401; 22 POST without csrf header → 403;
23 POST body validation (bad ids / `..` path / leading `/`) → 400; 24 POST authz failure
propagates status+reason (stub authorize inputs via mocked userRepos); 25 POST happy path
→ upsert called with session identity + defaults applied; 26 DELETE happy path → 204.

## Definition of done (gate — ALL must pass before merge)

1. `npm run typecheck` clean. 2. `npm test` — every pre-existing test still green
(127) plus all new ones. 3. **`npm run build` succeeds** — the route-export law is
enforced only here. 4. `.env.example`, `docs/DEPLOY.md` (new "Step 6 — enable the public
dashboard" incl. app→Public, callback URL `<base>/api/auth/callback`, client secret,
migration 0002), `README.md` (short Dashboard section) updated. 5. Law 16: all work on
branch `feat/onboarding-dashboard`; merge `--no-ff` into main and push ONLY when the full
gate is green; otherwise leave the branch unmerged and report.

## Forbidden
- New dependencies of ANY kind (no next-auth, iron-session, jose, zod, tailwind…) — Law 13.
- Sending, logging, or embedding the GitHub user token anywhere client-visible; logging
  secrets/cookies; `console.*` outside route handlers (`[guardrail-dash]` prefix) and the
  existing allowed files.
- Touching `src/types/*`, the pipeline, webhook route/handler, or any diff/scan/report module.
- Trusting any client-supplied repo id/name without re-running `authorizeLink` server-side.
- `octokit.rest.*` / `paginate` (adapters use `.request` only, per Track E convention).
