# Spec W0 — Scaffold, Frozen Types, Env, SQL

**Wave:** 0 (sequential — everything depends on this)
**Agent:** module-builder
**Files produced:**
`package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`, `.env.example`,
`supabase/migrations/0001_project_links.sql`,
`src/types/contract.ts`, `src/types/github.ts`, `src/types/db.ts`, `src/config/env.ts`,
`tests/config/env.test.ts`

## Purpose
Create the project skeleton and the FROZEN shared contracts every other track imports.
Precision matters more here than anywhere else: six agents build against these shapes
in parallel and none of them may edit these files.

## Step 1 — package.json
- `"name": "guardrail"`, `"private": true`, `"type": "module"`.
- Scripts: `dev: next dev`, `build: next build`, `start: next start`,
  `test: vitest run`, `typecheck: tsc --noEmit`.
- Dependencies (exact ranges, CLAUDE.md approved list):
  `next ^15.1.0`, `react ^19.0.0`, `react-dom ^19.0.0`, `typescript ^5.7.0`,
  `yaml ^2.6.0`, `octokit ^4.0.0`, `@supabase/supabase-js ^2.47.0`.
  NOTE: `typescript` goes in `dependencies` (the AST scanner imports it at runtime),
  not devDependencies.
- DevDependencies: `vitest ^3.0.0`, `@types/node ^22.0.0`, `@types/react ^19.0.0`.
- Run `npm install` and commit the lockfile.

## Step 2 — tsconfig.json
```jsonc
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM"], "module": "ESNext",
    "moduleResolution": "bundler", "strict": true, "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true, "skipLibCheck": true,
    "esModuleInterop": true, "resolveJsonModule": true, "isolatedModules": true,
    "jsx": "preserve", "incremental": true, "noEmit": true,
    "baseUrl": ".", "paths": { "@/*": ["./src/*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"],
  "exclude": ["node_modules"]
}
```

## Step 3 — next.config.ts
```ts
import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  serverExternalPackages: ['typescript'], // do not bundle the 8MB compiler
};
export default nextConfig;
```

## Step 4 — vitest.config.ts
- `resolve.alias: { '@': path.resolve(__dirname, 'src') }` (use `fileURLToPath(new URL('./src', import.meta.url))` since type is module).
- `test.environment: 'node'`, `test.include: ['tests/**/*.test.ts']`.

## Step 5 — .env.example
```
GITHUB_WEBHOOK_SECRET=replace-me
GITHUB_APP_ID=0
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nREPLACE\n-----END RSA PRIVATE KEY-----\n"
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-me
SCAN_CONCURRENCY=8
MAX_SCAN_FILES=2000
```

## Step 6 — supabase/migrations/0001_project_links.sql
EXACT DDL from the SRD (do not add columns):
```sql
CREATE TABLE project_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backend_repo_id BIGINT NOT NULL UNIQUE,
    frontend_repo_id BIGINT NOT NULL,
    openapi_file_path VARCHAR(255) DEFAULT 'openapi.json',
    frontend_src_directory VARCHAR(255) DEFAULT 'src',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```
Add one SQL comment above the table: monorepo support = backend_repo_id may equal
frontend_repo_id; only the backend column is UNIQUE (SRD §3).

## Step 7 — src/types/*.ts  (FROZEN — copy exactly from PLAN.md §5)
Transcribe the three type files verbatim from `docs/PLAN.md` §5. Every interface,
every field name, every optionality flag exactly as written there. Add a one-line
JSDoc per interface. No extra exports, no enums, no classes.

## Step 8 — src/config/env.ts
```ts
export interface Env {
  githubWebhookSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string;   // real newlines, already un-escaped
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  scanConcurrency: number;       // default 8
  maxScanFiles: number;          // default 2000
}
export function loadEnv(source?: NodeJS.ProcessEnv): Env;
```
Rules:
- `source` defaults to `process.env` — tests pass a stub; NEVER mutate the source.
- Required string vars: throw `new Error('Missing required env var: <NAME>')` listing
  the FIRST missing one. Do not log values.
- `githubAppPrivateKey`: apply `.replace(/\\n/g, '\n')`.
- Numeric vars: `Number.parseInt`; if unset/NaN/<= 0 → default (8 / 2000).
- Memoize the `process.env`-backed result in a module-level variable; a passed
  `source` bypasses the memo (for tests).

## Step 9 — directory placeholders
Create empty dirs the other tracks will fill: `src/lib/{crypto,diff,scan,db,github,report,pipeline}`,
`src/app/api/webhook/github`, `tests/fixtures`. Put a `.gitkeep` in each so git tracks them.

## Acceptance tests — tests/config/env.test.ts
1. loadEnv with a complete stub returns every field, numbers parsed.
2. Missing `GITHUB_WEBHOOK_SECRET` → throws with the var name in the message.
3. `GITHUB_APP_PRIVATE_KEY` containing literal `\n` sequences → result contains real newlines.
4. `SCAN_CONCURRENCY` unset → 8; `"abc"` → 8; `"16"` → 16.
5. `MAX_SCAN_FILES` unset → 2000.

## Definition of done
`npm install` clean, `npm run typecheck` green, `npm test` green (env tests only at this
point), all directories exist, lockfile committed.

## Forbidden
- zod or any validation lib (hand-rolled checks only — approved deps list).
- Editing `.gitignore` beyond adding `next-env.d.ts` and `.next/` if missing.
- Any file not listed above.
