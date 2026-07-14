import { loadDashboardEnv } from '@/config/env';
import { resolveSessionState } from './sessionState';
import { HeroBackdrop } from './HeroBackdrop';
import { ProductPanel } from './ProductPanel';
import { Reveal } from './Reveal';
import { CountUp } from './CountUp';

// Hero and CTA reflect the current request's auth state, so the page must render per-request.
export const dynamic = 'force-dynamic';

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

  const { login } = await resolveSessionState();

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
      <section className="hero">
        <span className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          Contract enforcement for GitHub
        </span>

        <h1 className="hero-title">
          Ship API changes without{' '}
          <span className="hero-title-accent">breaking the frontend.</span>
        </h1>

        <p className="hero-lede">
          Guardrail watches every backend pull request that changes your OpenAPI
          contract, scans the frontend for code that would break, and blocks the merge
          before it ships.
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
            {login ? (
              <a className="button button-primary button-lg" href="/dashboard">
                Go to dashboard →
              </a>
            ) : (
              <a className="button button-primary button-lg" href="/api/auth/login">
                Sign in with GitHub
              </a>
            )}
            {installHref && (
              <a className="button button-lg" href={installHref}>
                Install the GitHub App
              </a>
            )}
          </div>
        )}

        <ul className="hero-trust">
          <li>TypeScript compiler AST — no regex</li>
          <li>Fail-open by design</li>
          <li>Zero config to start</li>
        </ul>

        {/* Animated particle field — mounted LAST so it sits behind content
            (z-index) without shifting the staggered `rise` nth-child delays. */}
        <HeroBackdrop />
      </section>

      {/* ---------------- Product panel: the money shot ---------------- */}
      <ProductPanel />

      {/* ---------------- Proof strip (real numbers, no invented logos) ---------------- */}
      <Reveal>
        <div className="proof-strip">
          <div className="proof-stat">
            <CountUp className="proof-num" value={3} suffix="s" />
            <span className="proof-label">verdict on the live demo PR</span>
          </div>
          <div className="proof-stat">
            <CountUp className="proof-num" value={260} />
            <span className="proof-label">tests green on every commit</span>
          </div>
          <div className="proof-stat">
            <CountUp className="proof-num" value={100} suffix="%" />
            <span className="proof-label">open source on GitHub</span>
          </div>
        </div>
      </Reveal>

      {/* ---------------- How it works ---------------- */}
      <section className="section" id="how-it-works">
        <div className="container">
          <Reveal>
          <div className="section-head">
            <span className="section-kicker">How it works</span>
            <h2>
              From a webhook to a verdict{' '}
              <span className="h2-accent">in three steps.</span>
            </h2>
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
                Add the GitHub App to your backend and frontend repos, then pair them in
                the dashboard. Monorepos are a single link.
              </p>
            </li>
            <li className="step">
              <span className="step-num">2</span>
              <h3>Diff the contract</h3>
              <p>
                On every backend PR, Guardrail diffs the OpenAPI spec — deletions and
                type mutations become a precise list of breaking changes.
              </p>
            </li>
            <li className="step">
              <span className="step-num">3</span>
              <h3>Scan &amp; block</h3>
              <p>
                It walks the frontend with the TypeScript compiler to find real usages
                of broken fields, then passes or fails the check run.
              </p>
            </li>
          </ol>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Features ---------------- */}
      <section className="section section-rule" id="features">
        <div className="container">
          <Reveal>
          <div className="section-head">
            <span className="section-kicker">Why Guardrail</span>
            <h2>
              Precision where grep-based tools{' '}
              <span className="h2-accent">guess.</span>
            </h2>
          </div>

          <div className="feature-grid">
            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">{'{ }'}</span>
              <h3>AST-accurate, never regex</h3>
              <p>
                Field usage is detected with the TypeScript compiler API — property
                access and destructuring, aliases resolved to their source key. No false
                positives from comments or strings.
              </p>
            </article>

            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2l8 4v6c0 5-3.4 8-8 10-4.6-2-8-5-8-10V6l8-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                  <path d="M8.5 12l2.4 2.4L15.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <h3>Fail-open by law</h3>
              <p>
                If Guardrail itself errors, the check concludes as neutral — never a
                false failure. Your team is never blocked by our bugs.
              </p>
            </article>

            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </span>
              <h3>Answers in seconds</h3>
              <p>
                The webhook acks in milliseconds and the scan runs with bounded
                concurrency over the Git Blobs API — fast even on large frontends.
              </p>
            </article>

            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M3 9h18M8 4v16" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <h3>Monorepo or split</h3>
              <p>
                Backend and frontend in one repo or two — Guardrail scopes the scan to
                your source directory either way. One link, one source of truth.
              </p>
            </article>
          </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- FAQ ---------------- */}
      <section className="section section-rule" id="faq">
        <div className="container">
          <Reveal>
          <div className="section-head">
            <span className="section-kicker">FAQ</span>
            <h2>
              Questions before <span className="h2-accent">you get started?</span>
            </h2>
          </div>

          <div className="faq-grid">
            <article className="faq-card faq-card-dark">
              <h3>
                <span className="faq-q">?</span>
                How does Guardrail block a breaking PR?
              </h3>
              <p>
                It publishes a check run on every backend PR through the GitHub Checks
                API. With branch protection on, a failing Guardrail check blocks the
                merge until the breaking references are resolved.
              </p>
            </article>

            <article className="faq-card">
              <h3>
                <span className="faq-q">?</span>
                What counts as a breaking change?
              </h3>
              <p>
                Deleted fields and type mutations in your OpenAPI schemas. Guardrail
                diffs the spec on every PR and only flags changes that can break a
                consumer.
              </p>
            </article>

            <article className="faq-card">
              <h3>
                <span className="faq-q">?</span>
                How does it find frontend usage?
              </h3>
              <p>
                With the TypeScript compiler — property access, destructuring (aliases
                resolved to the source key), and bracket-literal access. Never regex, so
                comments and strings can&apos;t false-positive.
              </p>
            </article>

            <article className="faq-card">
              <h3>
                <span className="faq-q">?</span>
                What if Guardrail itself fails?
              </h3>
              <p>
                The check concludes as neutral, never failure. Guardrail&apos;s own
                errors are designed to never block your team&apos;s merges.
              </p>
            </article>

            <article className="faq-card">
              <h3>
                <span className="faq-q">?</span>
                Does it work in a monorepo?
              </h3>
              <p>
                Yes. The backend and frontend can be the same repository — the scan is
                scoped to the source directory you configure for the link.
              </p>
            </article>

            <article className="faq-card">
              <h3>
                <span className="faq-q">?</span>
                Does Guardrail store my code?
              </h3>
              <p>
                Files are fetched through the GitHub API for the duration of a scan.
                What persists is the verdict on the check run — not your source.
              </p>
            </article>
          </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- CTA band ---------------- */}
      {configured && appSlug && (
        <section className="container">
          <div className="cta-band">
            <h2>Put a guardrail on your contract.</h2>
            <p>Wire it up in a couple of minutes. It watches every PR from then on.</p>
            <div className="actions">
              {login ? (
                <a className="button button-primary button-lg" href="/dashboard">
                  Go to dashboard <span className="btn-arrow" aria-hidden="true">→</span>
                </a>
              ) : (
                <a className="button button-primary button-lg" href="/api/auth/login">
                  Sign in with GitHub
                </a>
              )}
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
