# Spec D — Database Mapping Layer (Supabase)

**Wave:** 1 | **Agent:** module-builder | **Depends on:** W0
**Files produced:** `src/lib/db/supabase.ts`, `src/lib/db/projectLinks.ts`,
`tests/db/projectLinks.test.ts`

## Purpose
SRD Module 3: resolve cross-repository dependencies via the `project_links` table.
Thin, injected, mockable — no query logic anywhere else in the codebase.

## File 1 — supabase.ts
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';
/** Server-side client (service role). Never import this in pure modules. */
export function createDbClient(env: Env): SupabaseClient;
```
Rules:
- `createClient(env.supabaseUrl, env.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })`.
- No module-level singleton constructed at import time (breaks tests & builds without
  env). The PIPELINE decides construction; memoization, if any, lives there.

## File 2 — projectLinks.ts
```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectLink } from '@/types/db';

/** Look up the link row for a backend repository. Null when the repo is not registered. */
export async function getProjectLinkByBackendRepoId(
  db: SupabaseClient,
  backendRepoId: number,
): Promise<ProjectLink | null>;
```
Implementation:
1. `db.from('project_links').select('*').eq('backend_repo_id', backendRepoId).maybeSingle()`.
2. `error` truthy → throw `new Error('project_links lookup failed: ' + error.message)`.
3. `data` null → return null. Otherwise coerce/return as `ProjectLink` with defaults
   applied defensively: `openapi_file_path ?? 'openapi.json'`,
   `frontend_src_directory ?? 'src'` (DB defaults exist, but rows inserted by hand may
   carry NULLs — SRD defaults win).
4. MONOREPO (SRD §3, Law 8): `backend_repo_id === frontend_repo_id` is a VALID row.
   Add a code comment stating this; no validation may reject it.

## Acceptance tests
Mock the Supabase client as a plain object chain (`from().select().eq().maybeSingle()`)
returning canned `{ data, error }` — do NOT hit the network, do NOT import createDbClient
in these tests.
1. Row found → returned typed object, fields intact.
2. `data: null, error: null` → null.
3. `error: { message: 'boom' }` → throws containing 'boom'.
4. Row with `openapi_file_path: null` → returned as `'openapi.json'`; same for src dir → `'src'`.
5. Monorepo row (`backend_repo_id === frontend_repo_id === 42`) → returned unchanged.

## Forbidden
- Any other table, any insert/update/delete (v1 rows are seeded manually — PLAN §7).
- Module-level `createClient` at import time.
- Importing `env.ts` inside projectLinks.ts (client is injected).
