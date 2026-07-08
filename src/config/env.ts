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

// ---------------------------------------------------------------------------------------
// Spec K — Public Onboarding Dashboard. A SEPARATE, authorized exception to the frozen-W0
// rule: this is an ADDITIVE export alongside Env/loadEnv, never a modification of them.
// The webhook pipeline must keep working on deployments that never configure the
// dashboard, so these vars are validated ONLY here, never folded into loadEnv()/Env.
// ---------------------------------------------------------------------------------------

export interface DashboardEnv {
  clientId: string;
  clientSecret: string;
  appSlug: string;
  sessionSecret: string;
  baseUrl: string;
}

const REQUIRED_DASHBOARD_VARS = [
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_SLUG',
  'GUARDRAIL_SESSION_SECRET',
  'APP_BASE_URL',
] as const;

let memoizedDashboard: DashboardEnv | undefined;

/**
 * Load and validate dashboard-only environment configuration.
 * @param source override for process.env (tests pass a stub); never mutated. When a
 *   source is provided the module-level memo is bypassed so tests stay isolated.
 */
export function loadDashboardEnv(source?: NodeJS.ProcessEnv): DashboardEnv {
  const usingProcessEnv = source === undefined;
  if (usingProcessEnv && memoizedDashboard) return memoizedDashboard;

  const src = source ?? process.env;

  for (const name of REQUIRED_DASHBOARD_VARS) {
    const value = src[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing required env var: ${name}`);
    }
  }

  const sessionSecret = src.GUARDRAIL_SESSION_SECRET!;
  if (sessionSecret.length < 32) {
    throw new Error('GUARDRAIL_SESSION_SECRET must be at least 32 characters');
  }

  const env: DashboardEnv = {
    clientId: src.GITHUB_APP_CLIENT_ID!,
    clientSecret: src.GITHUB_APP_CLIENT_SECRET!,
    appSlug: src.GITHUB_APP_SLUG!,
    sessionSecret,
    // Strip a trailing slash so callers can always do `${baseUrl}/path` without
    // risking a doubled slash.
    baseUrl: src.APP_BASE_URL!.replace(/\/$/, ''),
  };

  if (usingProcessEnv) memoizedDashboard = env;
  return env;
}
