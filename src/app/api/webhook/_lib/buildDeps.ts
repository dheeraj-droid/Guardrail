// Shared production PipelineDeps factory for the webhook route handlers.
//
// WHY `_lib`: the leading underscore opts this directory out of Next.js App Router
// routing (existing pattern: `src/app/api/_lib/`), so this is a plain module, not a
// route file.
//
// Extracted from the verbatim-duplicated `buildDeps()` that previously lived in both
// `webhook/github/handler.ts` and `webhook/process/handler.ts`.
import { loadEnv } from '@/config/env';
import { createDbClient } from '@/lib/db/supabase';
import { getInstallationClient } from '@/lib/github/client';
import type { PipelineDeps } from '@/lib/pipeline/processPullRequest';

/**
 * Constructs the production PipelineDeps. Called INSIDE the request/defer path only,
 * never at module top level (imports must stay side-effect free for tests and builds
 * without env vars).
 */
export function buildDeps(): PipelineDeps {
  const env = loadEnv();
  return { env, db: createDbClient(env), getInstallationClient };
}
