import Link from 'next/link';

/**
 * Styled 404 page. Server component reusing the existing `.card` / `.button`
 * design-system classes so it stays visually consistent with the rest of the site.
 */
export default function NotFound() {
  return (
    <section className="container route-state">
      <div className="card route-state-card">
        <span className="route-state-code">404</span>
        <h1>Page not found</h1>
        <p>The page you were looking for doesn&apos;t exist or may have moved.</p>
        <div className="actions">
          <Link className="button button-primary" href="/">
            Back to home
          </Link>
        </div>
      </div>
    </section>
  );
}
