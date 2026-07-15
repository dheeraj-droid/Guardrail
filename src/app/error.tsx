'use client';

import Link from 'next/link';

/**
 * Route-level error boundary for the app. Next.js renders this client component when
 * a rendering error escapes a segment. Kept minimal and dependency-free — it reuses
 * the existing `.card` / `.button` design-system classes so it matches the rest of
 * the site with no extra styling.
 */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="container route-state">
      <div className="card route-state-card">
        <h1>Something went wrong</h1>
        <p>
          An unexpected error occurred while rendering this page. You can try again — if
          the problem persists, the webhook pipeline is unaffected.
        </p>
        <div className="actions">
          <button type="button" className="button button-primary" onClick={() => reset()}>
            Try again
          </button>
          <Link className="button" href="/">
            Back to home
          </Link>
        </div>
      </div>
    </section>
  );
}
