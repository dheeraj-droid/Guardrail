'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AccessibleRepo } from '@/lib/github/userRepos';
import type { ProjectLinkRow } from '@/lib/db/linkAdmin';

// Every dashboard fetch carries this header — it is the CSRF defense requireCsrf() checks
// for on the server (see src/app/api/_lib/requireSession.ts).
const CSRF_HEADERS = { 'x-guardrail-request': 'dashboard' } as const;

interface LinkManagerProps {
  login: string;
}

interface ApiError {
  error?: string;
}

async function readErrorReason(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as ApiError;
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/** Plain React state only — no data-fetching libraries (CLAUDE.md Law 13). */
export function LinkManager({ login }: LinkManagerProps) {
  const [repos, setRepos] = useState<AccessibleRepo[]>([]);
  const [links, setLinks] = useState<ProjectLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [backendRepoId, setBackendRepoId] = useState('');
  const [frontendRepoId, setFrontendRepoId] = useState('');
  const [monorepo, setMonorepo] = useState(false);
  const [openapiFilePath, setOpenapiFilePath] = useState('');
  const [frontendSrcDirectory, setFrontendSrcDirectory] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reposRes, linksRes] = await Promise.all([
        fetch('/api/dashboard/repos', { headers: CSRF_HEADERS }),
        fetch('/api/links', { headers: CSRF_HEADERS }),
      ]);

      if (!reposRes.ok) {
        throw new Error(await readErrorReason(reposRes, 'failed to load repositories'));
      }
      if (!linksRes.ok) {
        throw new Error(await readErrorReason(linksRes, 'failed to load links'));
      }

      const reposBody = (await reposRes.json()) as { repos: AccessibleRepo[] };
      const linksBody = (await linksRes.json()) as { links: ProjectLinkRow[] };
      setRepos(reposBody.repos);
      setLinks(linksBody.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Suppressing react-hooks/set-state-in-effect here rather than fixing it "for real":
    // `load` also has to run from handleSubmit (line ~116) and the delete handler (line
    // ~134) to refresh the list after a mutation, so it can't be inlined into just this
    // effect without duplicating the fetch/setState logic three times. This is the
    // standard single mount-time fetch pattern (one effect, fires once, no other effect
    // reacts to the state it sets) — not the effect-chain/render-cascade case the rule
    // is designed to catch.
    //
    // Revisit this suppression if `load` (or this component) ever grows a second effect
    // that reacts to `repos`/`links`/`loading`/`error` — that would be the actual
    // cascading-render pattern the rule warns about, and at that point the fix is to
    // split `load` into a pure "fetch and return data" function, with each call site
    // (mount effect, post-create, post-delete) doing its own setState from the result,
    // so the effect itself no longer calls into shared state-setting code.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function repoFullName(id: number): string {
    const repo = repos.find((r) => r.id === id);
    return repo ? repo.fullName : String(id);
  }

  function handleMonorepoToggle(checked: boolean): void {
    setMonorepo(checked);
    if (checked) setFrontendRepoId(backendRepoId);
  }

  function handleBackendChange(value: string): void {
    setBackendRepoId(value);
    if (monorepo) setFrontendRepoId(value);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);

    const backendId = Number(backendRepoId);
    const frontendId = Number(monorepo ? backendRepoId : frontendRepoId);
    if (!backendId || !frontendId) {
      setError('Choose a backend and frontend repository.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/links', {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          backendRepoId: backendId,
          frontendRepoId: frontendId,
          openapiFilePath: openapiFilePath.trim() || undefined,
          frontendSrcDirectory: frontendSrcDirectory.trim() || undefined,
        }),
      });
      if (!res.ok) {
        throw new Error(await readErrorReason(res, 'failed to save the link'));
      }
      setOpenapiFilePath('');
      setFrontendSrcDirectory('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save the link');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(backendId: number): Promise<void> {
    setError(null);
    try {
      const res = await fetch(`/api/links?backendRepoId=${backendId}`, {
        method: 'DELETE',
        headers: CSRF_HEADERS,
      });
      if (!res.ok) {
        throw new Error(await readErrorReason(res, 'failed to delete the link'));
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to delete the link');
    }
  }

  const adminRepos = repos.filter((r) => r.canAdminister);

  return (
    <div className="dashboard container">
      <div className="dashboard-topbar">
        <div className="dashboard-intro">
          <span className="section-kicker">Dashboard</span>
          <h1>Linked repositories</h1>
          <p className="dashboard-signed-in">
            Signed in as <strong>@{login}</strong>
          </p>
        </div>
      </div>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Your links</h2>
          {!loading && links.length > 0 && (
            <span className="count-badge">{links.length}</span>
          )}
        </div>

        {loading ? (
          <p className="loading-row">
            <span className="spinner" aria-hidden="true" />
            Loading your repositories…
          </p>
        ) : links.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M9 12a3 3 0 0 1 3-3h4a3 3 0 0 1 0 6h-1M15 12a3 3 0 0 1-3 3H8a3 3 0 0 1 0-6h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <p className="empty-state-title">No links yet</p>
            <p className="empty-state-hint">Pair a backend and frontend repo below to get started.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Backend</th>
                  <th>Frontend</th>
                  <th>Spec path</th>
                  <th>Src dir</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id}>
                    <td className="cell-repo">{repoFullName(link.backend_repo_id)}</td>
                    <td className="cell-repo">{repoFullName(link.frontend_repo_id)}</td>
                    <td>
                      <code className="cell-code">{link.openapi_file_path}</code>
                    </td>
                    <td>
                      <code className="cell-code">{link.frontend_src_directory}</code>
                    </td>
                    <td className="cell-action">
                      <button
                        type="button"
                        className="button button-danger"
                        onClick={() => void handleDelete(link.backend_repo_id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Create or update a link</h2>
        </div>
        <p className="card-sub">
          Guardrail watches the backend repo for OpenAPI changes and scans the frontend
          for usages that would break.
        </p>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="form-grid">
            <label>
              <span className="label-text">Backend repository</span>
              <span className="label-hint">Admin or maintain access only</span>
              <select
                value={backendRepoId}
                onChange={(e) => handleBackendChange(e.target.value)}
                required
              >
                <option value="" disabled>
                  Select a repository…
                </option>
                {adminRepos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="label-text">Frontend repository</span>
              <span className="label-hint">Where Guardrail scans for usages</span>
              <select
                value={monorepo ? backendRepoId : frontendRepoId}
                onChange={(e) => setFrontendRepoId(e.target.value)}
                disabled={monorepo}
                required
              >
                <option value="" disabled>
                  Select a repository…
                </option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={monorepo}
              onChange={(e) => handleMonorepoToggle(e.target.checked)}
            />
            <span>
              Monorepo — backend and frontend live in the same repository
            </span>
          </label>

          <div className="form-grid">
            <label>
              <span className="label-text">OpenAPI spec path</span>
              <span className="label-hint">Path in the backend repo</span>
              <input
                type="text"
                placeholder="openapi.json"
                value={openapiFilePath}
                onChange={(e) => setOpenapiFilePath(e.target.value)}
              />
            </label>

            <label>
              <span className="label-text">Frontend source directory</span>
              <span className="label-hint">Scan is scoped to this prefix</span>
              <input
                type="text"
                placeholder="src"
                value={frontendSrcDirectory}
                onChange={(e) => setFrontendSrcDirectory(e.target.value)}
              />
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save link'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
