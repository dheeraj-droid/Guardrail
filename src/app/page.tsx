import { loadDashboardEnv } from '@/config/env';

/**
 * Public landing page (server component). MUST NOT throw when the dashboard env is
 * unset — `loadDashboardEnv()` is wrapped defensively so webhook-only deploys (no
 * dashboard configured yet) stay healthy and just show a "not configured" note.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const showAuthError = params.error === 'auth';

  let appSlug: string | null = null;
  let configured = true;
  try {
    appSlug = loadDashboardEnv().appSlug;
  } catch {
    configured = false;
  }

  return (
    <div className="landing">
      <h1>Guardrail</h1>
      <p className="tagline">
        Guardrail intercepts backend pull requests that change an OpenAPI contract, scans
        your linked frontend for code that would break, and blocks the merge before it
        ships — automatically, via the GitHub Checks API.
      </p>

      {showAuthError && <p className="notice notice-error">Sign-in failed. Please try again.</p>}

      {!configured && (
        <p className="notice">
          The dashboard is not configured on this deployment yet. The webhook pipeline is
          unaffected.
        </p>
      )}

      <ol className="steps">
        <li>Install the GitHub App on your backend and frontend repositories.</li>
        <li>Sign in with GitHub to authorize the dashboard.</li>
        <li>Pick your backend and frontend repos — Guardrail takes it from there.</li>
      </ol>

      {configured && appSlug && (
        <div className="actions">
          <a className="button" href={`https://github.com/apps/${appSlug}/installations/new`}>
            Install the GitHub App
          </a>
          <a className="button button-primary" href="/api/auth/login">
            Sign in with GitHub
          </a>
        </div>
      )}
    </div>
  );
}
