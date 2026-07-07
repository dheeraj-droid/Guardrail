import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';

/**
 * Server-side Supabase client (service role). Never import this in pure modules
 * (CLAUDE.md Law 2 — IO shell only).
 *
 * No module-level singleton is constructed at import time: doing so would require
 * env at import and break tests/builds. The pipeline decides construction;
 * memoization, if any, lives there (Spec D).
 */
export function createDbClient(env: Env): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
