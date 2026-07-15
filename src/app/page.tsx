import { loadDashboardEnv } from '@/config/env';
import { resolveSessionState } from './sessionState';
import { HeroBackdrop } from './HeroBackdrop';
import { ProductPanel } from './ProductPanel';
import { Reveal } from './Reveal';
import { CountUp } from './CountUp';

// Hero and CTA reflect the current request's auth state, so the page must render per-request.
export const dynamic = 'force-dynamic';

/**
 * Shared call-to-action block used in both the hero and the closing CTA band.
 * File-local server component so the two sites render identical markup. When signed
 * in, the primary action points at the dashboard; otherwise at GitHub sign-in. The
 * install link is optional (only when the GitHub App slug is configured).
 */
function CtaActions({ login, installHref }: { login: string | null; installHref: string | null }) {
  return (
    <div className="actions">
      {login ? (
        <a className="button button-primary button-lg" href="/dashboard">
          Go to dashboard <span className="btn-arrow" aria-hidden="true">→</span>
        </a>
      ) : (
        <a className="button button-primary button-lg" href="/api/auth/login">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.29-5.27-1.29-5.27-5.72 0-1.27.45-2.3 1.2-3.11-.12-.3-.52-1.48.11-3.08 0 0 .98-.31 3.16 1.19a10.9 10.9 0 0 1 5.75 0c2.18-1.5 3.16-1.19 3.16-1.19.63 1.6.23 2.78.11 3.08.75.81 1.2 1.84 1.2 3.11 0 4.45-2.71 5.42-5.29 5.71.42.36.79 1.06.79 2.14v3.18c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
          </svg>
          Sign in with GitHub
        </a>
      )}
      {installHref && (
        <a className="button button-lg" href={installHref}>
          Install the GitHub App <span className="btn-arrow" aria-hidden="true">→</span>
        </a>
      )}
    </div>
  );
}

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
      <section className="hero" id="hero">
        <div className="container hero-grid">
          <div className="hero-content">
            <span className="eyebrow">
              <span className="eyebrow-dot" aria-hidden="true" />
              Contract enforcement for GitHub
            </span>

            <h1 className="hero-title">
              Change the API.{' '}
              <span className="hero-title-accent">Know what breaks.</span>
            </h1>

            <p className="hero-lede">
              Guardrail checks every OpenAPI change against the frontend that depends
              on it — then blocks breaking pull requests before they merge.
            </p>

            {showAuthError && (
              <p className="notice notice-error" role="alert">
                Sign-in failed. Please try again.
              </p>
            )}

            {!configured && (
              <p className="notice">
                The dashboard is not configured on this deployment yet. The webhook
                pipeline is unaffected.
              </p>
            )}

            {configured && appSlug && (
              <CtaActions login={login} installHref={installHref} />
            )}

            <ul className="hero-trust">
              <li>Compiler AST, not regex</li>
              <li>Fail-open by design</li>
              <li>Zero config to start</li>
            </ul>
          </div>

          {/* Product panel: the money shot. Sits in the hero's second column on
              desktop, stacks beneath the copy on mobile. */}
          <ProductPanel />
        </div>

        {/* Animated particle field — mounted LAST so it sits behind content
            (z-index) without shifting the hero entrance. */}
        <HeroBackdrop />
      </section>

      {/* ---------------- Proof strip (real numbers, no invented logos) ---------------- */}
      <Reveal>
        <section className="proof" aria-label="Guardrail proof points">
          <div className="container proof-inner">
            <div className="proof-lede">
              Small footprint. Fast feedback.
              <span>Evidence from the public repository and live demo.</span>
            </div>
            <div className="proof-stat">
              <CountUp className="proof-num" value={3} suffix="s" />
              <span className="proof-label">live demo verdict</span>
            </div>
            <div className="proof-stat">
              <CountUp className="proof-num" value={260} />
              <span className="proof-label">tests green</span>
            </div>
            <div className="proof-stat">
              <CountUp className="proof-num" value={100} suffix="%" />
              <span className="proof-label">open source</span>
            </div>
          </div>
        </section>
      </Reveal>

      {/* ---------------- How it works ---------------- */}
      <section className="section" id="how-it-works">
        <div className="container">
          <Reveal>
            <div className="section-head">
              <div>
                <span className="section-kicker">How it works</span>
                <h2>
                  One webhook.{' '}
                  <span className="h2-accent">One decisive check.</span>
                </h2>
              </div>
              <p className="section-sub">
                Install once, connect your backend and frontend repositories, and every
                future contract change is checked automatically.
              </p>
            </div>

            <ol className="flow">
              <li className="flow-card">
                <div className="step-label">
                  <span>Connect</span>
                  <strong>01</strong>
                </div>
                <h3>Link the code that ships together.</h3>
                <p>
                  Add the GitHub App to your repositories and pair them in the
                  dashboard. Monorepos work as a single link.
                </p>
              </li>
              <li className="flow-arrow" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12h14m-5-5 5 5-5 5"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </li>
              <li className="flow-card">
                <div className="step-label">
                  <span>Analyze</span>
                  <strong>02</strong>
                </div>
                <h3>Diff the OpenAPI contract.</h3>
                <p>
                  Guardrail isolates deleted fields and type mutations — the changes
                  most likely to break a frontend consumer.
                </p>
              </li>
              <li className="flow-arrow" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12h14m-5-5 5 5-5 5"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </li>
              <li className="flow-card flow-card-final">
                <div className="step-label">
                  <span>Protect</span>
                  <strong>03</strong>
                </div>
                <h3>Find real usages and block.</h3>
                <p>
                  The TypeScript compiler traces affected frontend code and publishes an
                  exact GitHub check result.
                </p>
              </li>
            </ol>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Features ---------------- */}
      <section className="section section-soft" id="features">
        <div className="container">
          <Reveal>
            <div className="section-head">
              <div>
                <span className="section-kicker">Why Guardrail</span>
                <h2>
                  Signal you can trust.{' '}
                  <span className="h2-accent">Noise you can ignore.</span>
                </h2>
              </div>
              <p className="section-sub">
                Guardrail follows the code, not matching strings. The result is a
                precise list your team can act on without slowing down delivery.
              </p>
            </div>

            <div className="features-layout">
              <article className="feature-primary">
                <div>
                  <span className="feature-tag">TypeScript compiler API</span>
                  <h3>Understands your frontend like a compiler does.</h3>
                  <p>
                    Property access, destructuring, aliases, and bracket-literal access
                    are traced to their source key. Comments and strings never become
                    false alarms.
                  </p>
                </div>
                <div className="code-sample mono" aria-hidden="true">
                  <div>
                    <span className="ln">18</span>
                    <span className="comment">{'// alias resolved to phoneNumber'}</span>
                  </div>
                  <div>
                    <span className="ln">19</span>const {'{ '}
                    <span className="key">phoneNumber: contact</span>
                    {' }'} = user
                  </div>
                  <div>
                    <span className="ln">20</span>return format(contact)
                  </div>
                </div>
              </article>

              <div className="feature-stack">
                <article className="feature-card">
                  <span className="feature-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M12 3 20 7v5c0 5-3.4 8-8 10-4.6-2-8-5-8-10V7l8-4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      <path d="m8.5 12 2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <h3>Fail-open by law</h3>
                  <p>
                    Internal errors conclude neutral, so Guardrail never blocks your team
                    by mistake.
                  </p>
                </article>

                <article className="feature-card">
                  <span className="feature-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="m13 2-9 12h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <h3>Answers in seconds</h3>
                  <p>
                    Bounded concurrency keeps scans fast even across large frontend
                    codebases.
                  </p>
                </article>

                <div className="privacy-strip">
                  <div className="privacy-copy">
                    <span className="feature-icon" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
                        <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.7" />
                      </svg>
                    </span>
                    <div>
                      <h3>Your source is scanned, not stored.</h3>
                      <p>Files are fetched through GitHub only for the duration of the check.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- FAQ ---------------- */}
      <section className="section" id="faq">
        <div className="container faq-wrap">
          <Reveal>
            <div className="faq-intro">
              <span className="section-kicker">FAQ</span>
              <h2>
                Before you <span className="h2-accent">get started.</span>
              </h2>
              <p>
                The practical details behind checks, repository layouts, and how
                Guardrail handles failure.
              </p>
            </div>

            <div className="faq-list">
              <article className="faq-item">
                <div>
                  <h3>How does Guardrail block a breaking pull request?</h3>
                  <p>
                    It publishes a check run through the GitHub Checks API. With branch
                    protection enabled, a failing Guardrail check prevents merge until
                    the breaking references are resolved.
                  </p>
                </div>
                <span className="faq-q" aria-hidden="true">?</span>
              </article>

              <article className="faq-item">
                <div>
                  <h3>What counts as a breaking contract change?</h3>
                  <p>
                    Deleted fields and type mutations in your OpenAPI schemas. Guardrail
                    diffs the spec on every PR and only flags changes that can break a
                    consumer.
                  </p>
                </div>
                <span className="faq-q" aria-hidden="true">?</span>
              </article>

              <article className="faq-item">
                <div>
                  <h3>How does it find frontend usage?</h3>
                  <p>
                    With the TypeScript compiler — property access, destructuring
                    (aliases resolved to the source key), and bracket-literal access.
                    Never regex, so comments and strings can&apos;t false-positive.
                  </p>
                </div>
                <span className="faq-q" aria-hidden="true">?</span>
              </article>

              <article className="faq-item">
                <div>
                  <h3>What happens if Guardrail itself fails?</h3>
                  <p>
                    The check concludes as neutral, never failure. Guardrail&apos;s own
                    errors are designed to never block your team&apos;s merges.
                  </p>
                </div>
                <span className="faq-q" aria-hidden="true">?</span>
              </article>

              <article className="faq-item">
                <div>
                  <h3>Does it work with a monorepo?</h3>
                  <p>
                    Yes. The backend and frontend can be the same repository — the scan
                    is scoped to the source directory you configure for the link.
                  </p>
                </div>
                <span className="faq-q" aria-hidden="true">?</span>
              </article>

              <article className="faq-item">
                <div>
                  <h3>Does Guardrail store my code?</h3>
                  <p>
                    Files are fetched through the GitHub API for the duration of a scan.
                    What persists is the verdict on the check run — not your source.
                  </p>
                </div>
                <span className="faq-q" aria-hidden="true">?</span>
              </article>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- CTA band ---------------- */}
      {configured && appSlug && (
        <section className="cta-section container">
          <div className="cta-band">
            <div className="cta-copy">
              <h2>Make breaking changes obvious before they become incidents.</h2>
              <p>
                Install Guardrail, link your repositories, and let every pull request
                prove it is safe to merge.
              </p>
            </div>
            <CtaActions login={login} installHref={installHref} />
          </div>
        </section>
      )}
    </>
  );
}
