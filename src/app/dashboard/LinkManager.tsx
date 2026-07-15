'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AccessibleRepo } from '@/lib/github/userRepos';
import type { ProjectLinkRow } from '@/lib/db/linkAdmin';
import { DashboardBackdrop } from './DashboardBackdrop';
import {
  countProtectedBackends,
  findExistingLink,
  groupLinksByBackend,
  isUnknownRepo,
  pairKey,
  repoFullName as repoFullNameFor,
} from './linkManagerLogic';

// The row exit animation (fade + collapse) runs before the row leaves state.
// Keep this in sync with the .row-deleting animation duration in globals.css.
const DELETE_EXIT_MS = 300;

// Every dashboard fetch carries this header — it is the CSRF defense requireCsrf() checks
// for on the server (see src/app/api/_lib/requireSession.ts).
const CSRF_HEADERS = { 'x-guardrail-request': 'dashboard' } as const;

interface LinkManagerProps {
  login: string;
  /** GITHUB_APP_SLUG — used to link to the App's installation page from the onboarding CTA. */
  appSlug: string;
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

/** Small inline SVG icons — kept local so the component has no icon-lib dependency. */
function RepoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A2.5 2.5 0 016.5 3h11A2.5 2.5 0 0120 5.5v13A2.5 2.5 0 0117.5 21h-11A2.5 2.5 0 014 18.5v-13zM8 3v18"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 7h14M9 7V4h6v3m-8 0l1 13h8l1-13M10 11v5M14 11v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Plain React state only — no data-fetching libraries (CLAUDE.md Law 13). */
export function LinkManager({ login, appSlug }: LinkManagerProps) {
  const [repos, setRepos] = useState<AccessibleRepo[]>([]);
  const [links, setLinks] = useState<ProjectLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Split error state (T11): a load failure is a recoverable dead-end that gets a Retry
  // affordance; a mutation failure is a transient notice above the form.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Visually-hidden aria-live announcement text ("Link saved", "Link deleted", errors).
  const [announcement, setAnnouncement] = useState('');

  const [backendRepoId, setBackendRepoId] = useState('');
  const [frontendRepoId, setFrontendRepoId] = useState('');
  const [monorepo, setMonorepo] = useState(false);
  const [openapiFilePath, setOpenapiFilePath] = useState('');
  const [frontendSrcDirectory, setFrontendSrcDirectory] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Transient success feedback: "Saved ✓" on the button (~1.5s) and a one-shot
  // highlight flash on the freshly created row.
  const [saved, setSaved] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState<number | null>(null);
  // The row currently playing its exit animation before handleDelete removes it, and the
  // row showing its inline delete confirmation. Both keyed by the (backend, frontend) pair.
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const confirmPanelRef = useRef<HTMLDivElement | null>(null);
  // The Delete (trash) button element for each row, so focus can return to the
  // trigger when its confirmation is dismissed (Escape / Cancel / outside click).
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // Row key whose Delete trigger should regain focus once it re-renders after a
  // cancelled confirmation (the trash button unmounts while the confirm is open).
  // A ref rather than state: it is read from an effect without triggering a render.
  const pendingRestoreRef = useRef<string | null>(null);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
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
      const message = err instanceof Error ? err.message : 'failed to load dashboard data';
      setLoadError(message);
      setAnnouncement(`Could not load your dashboard: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Single mount-time fetch. `load` is also called from the submit/delete handlers to
    // refresh after a mutation, so it stays a useCallback rather than being inlined here.
    // This is the standard single-fetch-on-mount pattern (one effect, fires once), not the
    // effect-chain/render-cascade case the rule guards against — see the original note.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Manage focus around the inline confirmation. When one opens, focus moves onto
  // the Confirm button. When it closes after a cancel (Escape / Cancel / outside
  // click), focus returns to the row's re-mounted Delete trigger so keyboard users
  // are not stranded on a removed control.
  useEffect(() => {
    if (confirmingKey !== null) {
      confirmRef.current?.focus();
      return;
    }
    const restoreKey = pendingRestoreRef.current;
    if (restoreKey !== null) {
      pendingRestoreRef.current = null;
      triggerRefs.current.get(restoreKey)?.focus();
    }
  }, [confirmingKey]);

  // Escape or an outside pointer-press cancels an open confirmation and returns
  // focus to the row's Delete trigger.
  useEffect(() => {
    if (confirmingKey === null) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') cancelConfirm();
    }
    function onPointerDown(e: PointerEvent): void {
      const panel = confirmPanelRef.current;
      if (panel && e.target instanceof Node && !panel.contains(e.target)) {
        cancelConfirm();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
    // `cancelConfirm` only reads `confirmingKey`, which already re-runs this effect;
    // adding it as a dep would churn listeners on every render for no behavioural gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmingKey]);

  function repoFullName(id: number): string {
    return repoFullNameFor(repos, id);
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
    setMutationError(null);

    const backendId = Number(backendRepoId);
    const frontendId = Number(monorepo ? backendRepoId : frontendRepoId);
    if (!backendId || !frontendId) {
      setMutationError('Choose a backend and frontend repository.');
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
      setJustCreatedId(backendId);
      setSaved(true);
      setAnnouncement('Link saved.');
      timers.current.push(setTimeout(() => setSaved(false), 1500));
      timers.current.push(setTimeout(() => setJustCreatedId(null), 1300));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to save the link';
      setMutationError(message);
      setAnnouncement(`Could not save the link: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }

  function cancelConfirm(): void {
    if (confirmingKey !== null) pendingRestoreRef.current = confirmingKey;
    setConfirmingKey(null);
  }

  // Play the row's fade + collapse exit, THEN run the actual delete.
  function requestDelete(backendId: number, frontendId: number): void {
    if (deletingKey !== null) return; // one exit at a time
    setConfirmingKey(null);
    const key = pairKey(backendId, frontendId);
    setDeletingKey(key);
    timers.current.push(
      setTimeout(() => {
        void handleDelete(backendId, frontendId);
      }, DELETE_EXIT_MS),
    );
  }

  async function handleDelete(backendId: number, frontendId: number): Promise<void> {
    setMutationError(null);
    try {
      const res = await fetch(
        `/api/links?backendRepoId=${backendId}&frontendRepoId=${frontendId}`,
        {
          method: 'DELETE',
          headers: CSRF_HEADERS,
        },
      );
      if (!res.ok) {
        throw new Error(await readErrorReason(res, 'failed to delete the link'));
      }
      await load();
      setAnnouncement('Link deleted.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to delete the link';
      setMutationError(message);
      setAnnouncement(`Could not delete the link: ${message}`);
    } finally {
      // On success the row is gone after load(); on error it snaps back visible.
      setDeletingKey(null);
    }
  }

  const adminRepos = repos.filter((r) => r.canAdminister);
  const groups = groupLinksByBackend(links);
  const selectedBackendId = Number(backendRepoId);
  const selectedFrontendId = Number(monorepo ? backendRepoId : frontendRepoId);
  const existing = findExistingLink(links, selectedBackendId, selectedFrontendId);
  const showEmptyAdminOnboarding = !loading && !loadError && adminRepos.length === 0;
  const installUrl = `https://github.com/apps/${appSlug}/installations/new`;

  return (
    <div className="dashboard container">
      <DashboardBackdrop />

      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      <div className="dashboard-topbar">
        <div className="dashboard-intro">
          <span className="section-kicker section-kicker-live">Dashboard</span>
          <h1>Repository links</h1>
          <p className="dashboard-signed-in">
            Signed in as <strong>@{login}</strong>
          </p>
        </div>
      </div>

      {!showEmptyAdminOnboarding && !loading && !loadError && links.length > 0 && (
        <section className="dashboard-stats" aria-label="Dashboard status">
          <div className="stat">
            <span className="stat-label">Active links</span>
            <span className="stat-value">
              {links.length} {links.length === 1 ? 'repository pair' : 'repository pairs'}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Protected backends</span>
            <span className="stat-value">
              {countProtectedBackends(links)}{' '}
              {countProtectedBackends(links) === 1 ? 'repository' : 'repositories'}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Connection</span>
            <span className="stat-value">
              <i className="status-dot" aria-hidden="true" />
              GitHub access ready
            </span>
          </div>
        </section>
      )}

      {loadError && (
        <div className="notice notice-error dashboard-load-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            className="button dashboard-retry"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {mutationError && (
        <p className="notice notice-error" role="alert">
          {mutationError}
        </p>
      )}

      {showEmptyAdminOnboarding ? (
        <section className="card dashboard-onboarding" data-component-id="empty-admin-onboarding">
          <span className="empty-state-icon" aria-hidden="true">
            <svg width="27" height="27" viewBox="0 0 24 24" fill="none">
              <path
                d="M9 12a3 3 0 013-3h4a3 3 0 010 6h-1M15 12a3 3 0 01-3 3H8a3 3 0 010-6h1"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <h2 className="empty-state-title">No repositories Guardrail can administer</h2>
          <p className="empty-state-hint">
            Guardrail can&apos;t see any repos you administer. Install the GitHub App on the
            repositories you want to protect, then reload this page — repositories are limited
            to those available to the installed GitHub App.
          </p>
          <a className="button button-primary" href={installUrl} target="_blank" rel="noopener noreferrer">
            Install the GitHub App
          </a>
        </section>
      ) : null}

      {!showEmptyAdminOnboarding && (
        <section className="card" data-component-id="repository-link-list">
          <div className="card-head">
            <h2>Your links</h2>
            {!loading && links.length > 0 && (
              // key on the value so a changed count remounts the badge and replays
              // its pop — a static number never animates.
              <span key={links.length} className="count-badge" aria-label={`${links.length} links`}>
                {links.length}
              </span>
            )}
          </div>
          <p className="card-sub">Each pair becomes a contract check on backend pull requests.</p>

          {loading ? (
            <div className="skeleton-rows">
              <span className="sr-only" role="status">
                Loading your repositories…
              </span>
              <span className="skeleton-row" aria-hidden="true" />
              <span className="skeleton-row" aria-hidden="true" />
              <span className="skeleton-row" aria-hidden="true" />
            </div>
          ) : links.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M9 12a3 3 0 0 1 3-3h4a3 3 0 0 1 0 6h-1M15 12a3 3 0 0 1-3 3H8a3 3 0 0 1 0-6h1"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <p className="empty-state-title">No links yet</p>
              <p className="empty-state-hint">
                Pair a backend and frontend repo below to get started.
              </p>
            </div>
          ) : (
            <div className="link-groups">
              {groups.map((group) => {
                const backendName = repoFullName(group.backendRepoId);
                const backendUnknown = isUnknownRepo(repos, group.backendRepoId);
                const first = group.links[0];
                const frontendCount = group.links.length;
                return (
                  <article
                    key={group.backendRepoId}
                    className="link-group"
                    data-component-id={`backend-group-${group.backendRepoId}`}
                  >
                    <div className="repo-line">
                      <span className="repo-icon" aria-hidden="true">
                        <RepoIcon />
                      </span>
                      <div className="repo-line-text">
                        <div
                          className="repo-name"
                          title={
                            backendUnknown
                              ? 'The Guardrail GitHub App may have been uninstalled from this repository, or you lost access.'
                              : undefined
                          }
                        >
                          {backendName}
                        </div>
                        <div className="repo-role">
                          Backend repository · {frontendCount}{' '}
                          {frontendCount === 1 ? 'linked frontend' : 'linked frontends'}
                        </div>
                      </div>
                      {first && <code className="spec-chip">{first.openapi_file_path}</code>}
                    </div>
                    <div className="connector" aria-hidden="true" />
                    <div className="frontend-list">
                      {group.links.map((link) => {
                        const key = pairKey(link.backend_repo_id, link.frontend_repo_id);
                        const frontendName = repoFullName(link.frontend_repo_id);
                        const frontendUnknown = isUnknownRepo(repos, link.frontend_repo_id);
                        const isConfirming = confirmingKey === key;
                        const isDeleting = deletingKey === key;
                        return (
                          <div
                            key={link.id}
                            className={`frontend-row${isDeleting ? ' row-deleting' : ''}${
                              link.backend_repo_id === justCreatedId ? ' row-created' : ''
                            }`}
                            data-component-id={`link-${key}`}
                          >
                            <div className="frontend-row-main">
                              <div className="frontend-main">
                                <span className="mini-icon" aria-hidden="true">
                                  <CodeIcon />
                                </span>
                                <div className="frontend-text">
                                  <div
                                    className="frontend-name"
                                    title={
                                      frontendUnknown
                                        ? 'The Guardrail GitHub App may have been uninstalled from this repository, or you lost access.'
                                        : undefined
                                    }
                                  >
                                    {frontendName}
                                  </div>
                                  <code className="path">{link.frontend_src_directory}</code>
                                </div>
                              </div>
                              {!isConfirming && (
                                <button
                                  ref={(el) => {
                                    if (el) triggerRefs.current.set(key, el);
                                    else triggerRefs.current.delete(key);
                                  }}
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Delete link to ${frontendName}`}
                                  onClick={() => setConfirmingKey(key)}
                                  disabled={deletingKey !== null}
                                >
                                  <TrashIcon />
                                </button>
                              )}
                            </div>
                            {isConfirming && (
                              <div
                                ref={confirmPanelRef}
                                className="confirm"
                                role="alertdialog"
                                aria-label="Delete link?"
                                data-component-id={`delete-confirm-${key}`}
                              >
                                <div>
                                  <strong>Delete link?</strong>
                                  <p>
                                    Guardrail will stop checking {frontendName} when{' '}
                                    {backendName} changes.
                                  </p>
                                </div>
                                <div className="confirm-actions">
                                  <button
                                    type="button"
                                    className="button button-quiet"
                                    onClick={cancelConfirm}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    ref={confirmRef}
                                    type="button"
                                    className="button button-danger-solid"
                                    onClick={() =>
                                      requestDelete(link.backend_repo_id, link.frontend_repo_id)
                                    }
                                  >
                                    Confirm
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {!showEmptyAdminOnboarding && (
        <section className="card" data-component-id="add-repository-link-form">
          <div className="card-head">
            <h2>{existing ? 'Update a link' : 'Create or update a link'}</h2>
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
                  disabled={loading}
                  required
                >
                  <option value="" disabled>
                    {loading ? 'Loading repositories…' : 'Select a repository…'}
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
                  disabled={monorepo || loading}
                  required
                >
                  <option value="" disabled>
                    {loading ? 'Waiting for repositories…' : 'Select a repository…'}
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
                disabled={loading}
              />
              <span>Monorepo — backend and frontend live in the same repository</span>
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
                  disabled={loading}
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
                  disabled={loading}
                />
              </label>
            </div>

            {existing && (
              <p className="label-hint form-upsert-hint" role="status">
                A link already exists for this pair — saving will replace it.
              </p>
            )}

            <div className="form-actions">
              <button
                type="submit"
                className={`button button-primary${saved ? ' is-saved' : ''}`}
                disabled={submitting || loading}
              >
                {submitting
                  ? 'Saving…'
                  : saved
                    ? 'Saved ✓'
                    : existing
                      ? 'Update link'
                      : 'Save link'}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
