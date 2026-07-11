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

  const installHref = appSlug
    ? `https://github.com/apps/${appSlug}/installations/new`
    : null;

  return (
    <>
      {/* ---------------- Hero ---------------- */}
      <section className="hero container">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            Automated contract enforcement
          </span>

          <h1 className="hero-title">
            Ship API changes without <span className="hero-title-accent">breaking the frontend</span>.
          </h1>

          <p className="hero-lede">
            Guardrail intercepts backend pull requests that change an OpenAPI contract,
            scans your linked frontend for code that would break, and blocks the merge
            before it ships — automatically, through the GitHub Checks API.
          </p>

          {showAuthError && (
            <p className="notice notice-error" role="alert">
              Sign-in failed. Please try again.
            </p>
          )}

          {!configured && (
            <p className="notice">
              The dashboard is not configured on this deployment yet. The webhook pipeline
              is unaffected.
            </p>
          )}

          {configured && appSlug && (
            <div className="actions">
              <a className="button button-primary button-lg" href="/api/auth/login">
                Sign in with GitHub
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
              {installHref && (
                <a className="button button-lg" href={installHref}>
                  Install the GitHub App
                </a>
              )}
            </div>
          )}

          <ul className="hero-trust">
            <li>No regex — TypeScript compiler AST</li>
            <li>Fail-open by design</li>
            <li>Zero config to start</li>
          </ul>
        </div>

        {/* The money shot: a GitHub-checks panel catching a breaking change. */}
        <div className="hero-visual" aria-hidden="true">
          <div className="check-card">
            <div className="check-card-header">
              <div className="check-card-pr">
                <span className="pr-badge">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11.5 3a1.5 1.5 0 1 0-1.9 1.44v6.12a1.5 1.5 0 1 0 1 0V4.44A1.5 1.5 0 0 0 11.5 3ZM4.5 3a1.5 1.5 0 1 0-1 2.83v4.34a1.5 1.5 0 1 0 1 0V5.83A1.5 1.5 0 0 0 4.5 3Z" />
                  </svg>
                  #482
                </span>
                <span className="check-card-title">
                  Remove deprecated <code>phoneNumber</code> from User
                </span>
              </div>
            </div>

            <div className="check-list">
              <div className="check-row check-row-pass">
                <span className="check-icon check-icon-pass" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="check-name">build</span>
                <span className="check-status">Passed</span>
              </div>
              <div className="check-row check-row-pass">
                <span className="check-icon check-icon-pass" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="check-name">unit-tests</span>
                <span className="check-status">Passed</span>
              </div>
              <div className="check-row check-row-fail">
                <span className="check-icon check-icon-fail" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="check-name">Guardrail / contract</span>
                <span className="check-status check-status-fail">2 breaking usages</span>
              </div>
            </div>

            <div className="check-detail">
              <p className="check-detail-head">
                <span className="check-detail-dot" /> Deleted field <code>User.phoneNumber</code> is
                still used in the frontend
              </p>
              <ul className="check-detail-list">
                <li>
                  <span className="file">web/src/ProfileCard.tsx</span>
                  <span className="loc">:24</span>
                  <code className="usage">user.phoneNumber</code>
                </li>
                <li>
                  <span className="file">web/src/checkout/Contact.tsx</span>
                  <span className="loc">:11</span>
                  <code className="usage">const {'{ phoneNumber }'} = user</code>
                </li>
              </ul>
            </div>

            <div className="check-blocked">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3.7 3.7l8.6 8.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Merging is blocked
            </div>
          </div>

          <div className="hero-visual-glow" />
        </div>
      </section>

      {/* ---------------- How it works ---------------- */}
      <section className="section container" id="how-it-works">
        <div className="section-head">
          <span className="section-kicker">How it works</span>
          <h2>Three steps between a webhook and a verdict.</h2>
          <p className="section-sub">
            Install once, link your repositories, and every future contract change is
            checked before it can merge.
          </p>
        </div>

        <ol className="steps">
          <li className="step">
            <span className="step-num">1</span>
            <h3>Install &amp; link</h3>
            <p>
              Add the GitHub App to your backend and frontend repos, then pair them in the
              dashboard. Monorepos are a single link.
            </p>
          </li>
          <li className="step">
            <span className="step-num">2</span>
            <h3>Diff the contract</h3>
            <p>
              On every backend PR, Guardrail diffs the OpenAPI spec — deletions, type
              mutations, renames — into a precise list of breaking changes.
            </p>
          </li>
          <li className="step">
            <span className="step-num">3</span>
            <h3>Scan &amp; block</h3>
            <p>
              It walks the frontend with the TypeScript compiler to find real usages of
              broken fields, then passes or fails the check run accordingly.
            </p>
          </li>
        </ol>
      </section>

      {/* ---------------- Features ---------------- */}
      <section className="section container" id="features">
        <div className="section-head">
          <span className="section-kicker">Why Guardrail</span>
          <h2>Precision where grep-based tools guess.</h2>
        </div>

        <div className="feature-grid">
          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">{'{ }'}</span>
            <h3>AST-accurate, never regex</h3>
            <p>
              Field usage is detected with the TypeScript compiler API — property access
              and destructuring, aliases resolved to their source key. No false positives
              from comments or strings.
            </p>
          </article>

          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M12 2l8 4v6c0 5-3.4 8-8 10-4.6-2-8-5-8-10V6l8-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M8.5 12l2.4 2.4L15.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <h3>Fail-open by law</h3>
            <p>
              If Guardrail itself errors, the check concludes as neutral — never a false
              failure. Your team is never blocked by our bugs.
            </p>
          </article>

          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </span>
            <h3>Answers in seconds</h3>
            <p>
              The webhook acks in milliseconds and the scan runs with bounded concurrency
              over the Git Blobs API — fast even on large frontends.
            </p>
          </article>

          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3 9h18M8 4v16" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </span>
            <h3>Monorepo or split</h3>
            <p>
              Backend and frontend in one repo or two — Guardrail scopes the scan to your
              source directory either way. One link, one source of truth.
            </p>
          </article>
        </div>
      </section>

      {/* ---------------- CTA band ---------------- */}
      {configured && appSlug && (
        <section className="container">
          <div className="cta-band">
            <div className="cta-band-glow" aria-hidden="true" />
            <h2>Put a guardrail on your contract.</h2>
            <p>Wire it up in a couple of minutes. It watches every PR from then on.</p>
            <div className="actions actions-center">
              <a className="button button-primary button-lg" href="/api/auth/login">
                Sign in with GitHub
              </a>
              {installHref && (
                <a className="button button-lg" href={installHref}>
                  Install the GitHub App
                </a>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
