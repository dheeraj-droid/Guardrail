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

  async function handleLogout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: CSRF_HEADERS });
    } finally {
      window.location.href = '/';
    }
  }

  const adminRepos = repos.filter((r) => r.canAdminister);

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <p>
          Signed in as <strong>{login}</strong>
        </p>
        <button type="button" className="button" onClick={() => void handleLogout()}>
          Log out
        </button>
      </div>

      {error && <p className="notice notice-error">{error}</p>}

      <section className="card">
        <h2>Linked repositories</h2>
        {loading ? (
          <p className="loading-row">
            <span className="spinner" aria-hidden="true" />
            Loading…
          </p>
        ) : links.length === 0 ? (
          <p className="empty-state">No links yet — create one below.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Backend</th>
                  <th>Frontend</th>
                  <th>Spec path</th>
                  <th>Src dir</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id}>
                    <td>{repoFullName(link.backend_repo_id)}</td>
                    <td>{repoFullName(link.frontend_repo_id)}</td>
                    <td>{link.openapi_file_path}</td>
                    <td>{link.frontend_src_directory}</td>
                    <td>
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
        <h2>Create or update a link</h2>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label>
            Backend repository (admin/maintain only)
            <select value={backendRepoId} onChange={(e) => handleBackendChange(e.target.value)} required>
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

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={monorepo}
              onChange={(e) => handleMonorepoToggle(e.target.checked)}
            />
            Monorepo (same repo)
          </label>

          <label>
            Frontend repository
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

          <label>
            OpenAPI spec path
            <input
              type="text"
              placeholder="openapi.json"
              value={openapiFilePath}
              onChange={(e) => setOpenapiFilePath(e.target.value)}
            />
          </label>

          <label>
            Frontend source directory
            <input
              type="text"
              placeholder="src"
              value={frontendSrcDirectory}
              onChange={(e) => setFrontendSrcDirectory(e.target.value)}
            />
          </label>

          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save link'}
          </button>
        </form>
      </section>
    </div>
  );
}
