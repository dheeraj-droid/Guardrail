// The ONLY module permitted to read process.env (CLAUDE.md — env access rule).

export interface Env {
  githubWebhookSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string; // real newlines, already un-escaped
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  scanConcurrency: number; // default 8
  maxScanFiles: number; // default 2000
}

const REQUIRED_STRING_VARS = [
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

let memoized: Env | undefined;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

/**
 * Load and validate environment configuration.
 * @param source override for process.env (tests pass a stub); never mutated. When a
 *   source is provided the module-level memo is bypassed so tests stay isolated.
 */
export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  const usingProcessEnv = source === undefined;
  if (usingProcessEnv && memoized) return memoized;

  const src = source ?? process.env;

  for (const name of REQUIRED_STRING_VARS) {
    const value = src[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing required env var: ${name}`);
    }
  }

  const env: Env = {
    githubWebhookSecret: src.GITHUB_WEBHOOK_SECRET!,
    githubAppId: src.GITHUB_APP_ID!,
    // GitHub App private keys are commonly stored with escaped newlines in env vars.
    githubAppPrivateKey: src.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    supabaseUrl: src.SUPABASE_URL!,
    supabaseServiceRoleKey: src.SUPABASE_SERVICE_ROLE_KEY!,
    scanConcurrency: parsePositiveInt(src.SCAN_CONCURRENCY, 8),
    maxScanFiles: parsePositiveInt(src.MAX_SCAN_FILES, 2000),
  };

  if (usingProcessEnv) memoized = env;
  return env;
}
