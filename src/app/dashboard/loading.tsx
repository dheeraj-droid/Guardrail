// T11 — route-level loading UI for /dashboard. Next.js renders this instantly while the
// server component (page.tsx) resolves the session, so the shell never flashes blank. It
// mirrors the in-component skeleton (.skeleton-rows) LinkManager shows while it fetches,
// so the loading experience is continuous from route transition → data fetch.
export default function DashboardLoading() {
  return (
    <div className="dashboard container">
      <div className="dashboard-topbar">
        <div className="dashboard-intro">
          <span className="section-kicker section-kicker-live">Dashboard</span>
          <h1>Repository links</h1>
          <p className="dashboard-signed-in">Loading your workspace…</p>
        </div>
      </div>

      <section className="card" aria-hidden="true">
        <div className="card-head">
          <h2>Your links</h2>
        </div>
        <div className="skeleton-rows">
          <span className="sr-only" role="status">
            Loading your repositories…
          </span>
          <span className="skeleton-row" aria-hidden="true" />
          <span className="skeleton-row" aria-hidden="true" />
          <span className="skeleton-row" aria-hidden="true" />
        </div>
      </section>
    </div>
  );
}
