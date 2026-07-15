// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LinkManager } from '@/app/dashboard/LinkManager';
import type { AccessibleRepo } from '@/lib/github/userRepos';
import type { ProjectLinkRow } from '@/lib/db/linkAdmin';

const CSRF_HEADER = 'x-guardrail-request';

function repo(id: number, fullName: string, canAdminister = true): AccessibleRepo {
  return {
    id,
    fullName,
    owner: fullName.split('/')[0] ?? 'acme',
    name: fullName.split('/')[1] ?? fullName,
    canAdminister,
    installationId: 1,
  };
}

function link(id: string, backend: number, frontend: number): ProjectLinkRow {
  return {
    id,
    backend_repo_id: backend,
    frontend_repo_id: frontend,
    openapi_file_path: 'openapi.json',
    frontend_src_directory: 'src',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

const REPOS: AccessibleRepo[] = [
  repo(10, 'acme/payments-api'),
  repo(20, 'acme/web-store'),
];

interface FetchState {
  repos: AccessibleRepo[];
  links: ProjectLinkRow[];
  failRepos: boolean;
}

// A programmable fetch stub covering the four endpoints LinkManager talks to. Each call is
// recorded so tests can assert method, URL, and the CSRF header on EVERY request.
function installFetch(state: FetchState) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = normalizeHeaders(init?.headers);
    calls.push({ url, method, headers });

    if (url.startsWith('/api/dashboard/repos')) {
      if (state.failRepos) {
        return jsonResponse({ error: 'boom: repos unavailable' }, false, 500);
      }
      return jsonResponse({ repos: state.repos }, true, 200);
    }
    if (url.startsWith('/api/links') && method === 'GET') {
      return jsonResponse({ links: state.links }, true, 200);
    }
    if (url.startsWith('/api/links') && method === 'POST') {
      return jsonResponse({ ok: true }, true, 200);
    }
    if (url.startsWith('/api/links') && method === 'DELETE') {
      return jsonResponse({ ok: true }, true, 200);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  globalThis.fetch = impl as unknown as typeof fetch;
  return { calls, impl };
}

function normalizeHeaders(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(init)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function jsonResponse(body: unknown, ok: boolean, status: number): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// Select the backend + frontend repos in the form. Returns after both change events fire.
// Explicit lookups keep noUncheckedIndexedAccess happy.
function selectPair(backendId: number, frontendId: number): void {
  const selects = screen.getAllByRole('combobox');
  const backend = selects[0];
  const frontend = selects[1];
  if (!backend || !frontend) throw new Error('expected backend and frontend selects');
  fireEvent.change(backend, { target: { value: String(backendId) } });
  fireEvent.change(frontend, { target: { value: String(frontendId) } });
}

describe('LinkManager', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(a) renders the skeleton first, then the grouped link cards after both fetches resolve', async () => {
    installFetch({
      repos: REPOS,
      links: [link('l1', 10, 20)],
      failRepos: false,
    });
    render(<LinkManager login="octocat" appSlug="guardrail-app" />);

    // Skeleton is shown while loading.
    expect(screen.getByText('Loading your repositories…')).not.toBeNull();

    // After both fetches resolve, the grouped card for the backend appears. The repo name
    // also appears inside the <select> options, so scope to the card's `.repo-name`.
    await waitFor(() => {
      expect(screen.getByText('acme/payments-api', { selector: '.repo-name' })).not.toBeNull();
    });
    expect(screen.getByText('acme/web-store', { selector: '.frontend-name' })).not.toBeNull();
    expect(screen.queryByText('Loading your repositories…')).toBeNull();
  });

  it('(b) shows the install-app onboarding CTA when there are no admin repos', async () => {
    installFetch({
      repos: [repo(20, 'acme/web-store', false)], // present but not administrable
      links: [],
      failRepos: false,
    });
    render(<LinkManager login="octocat" appSlug="guardrail-app" />);

    await waitFor(() => {
      expect(screen.getByText('No repositories Guardrail can administer')).not.toBeNull();
    });
    const cta = screen.getByRole('link', { name: 'Install the GitHub App' });
    expect(cta.getAttribute('href')).toBe(
      'https://github.com/apps/guardrail-app/installations/new',
    );
    // The link list / form are not rendered in the empty-admin state.
    expect(screen.queryByText('Your links')).toBeNull();
  });

  it('(c) shows a load error with Retry; clicking Retry refetches and recovers', async () => {
    const state: FetchState = { repos: REPOS, links: [link('l1', 10, 20)], failRepos: true };
    installFetch(state);
    render(<LinkManager login="octocat" appSlug="guardrail-app" />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    // The reason renders in the load-error notice (also echoed in the aria-live region).
    expect(screen.getByText(/boom: repos unavailable/, { selector: '.dashboard-load-error span' }))
      .not.toBeNull();

    // Fix the backend and retry.
    state.failRepos = false;
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByText('acme/payments-api', { selector: '.repo-name' })).not.toBeNull();
    });
    // The load-error notice is gone (the aria-live region may retain its last announcement).
    expect(document.querySelector('.dashboard-load-error')).toBeNull();
  });

  it('(d) delete flow: confirm appears + focused, Escape and Cancel dismiss, Confirm DELETEs both ids and removes the row', async () => {
    const state: FetchState = { repos: REPOS, links: [link('l1', 10, 20)], failRepos: false };
    const { calls } = installFetch(state);
    render(<LinkManager login="octocat" appSlug="guardrail-app" />);

    await screen.findByRole('button', { name: 'Delete link to acme/web-store' });

    // Open the inline confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Delete link to acme/web-store' }));
    let confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    // Focus moved onto Confirm.
    expect(document.activeElement).toBe(confirmBtn);

    // Escape dismisses.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull());

    // Re-open, then Cancel dismisses.
    fireEvent.click(screen.getByRole('button', { name: 'Delete link to acme/web-store' }));
    await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull());

    // Re-open and Confirm through — the row exit animation runs first, then DELETE.
    fireEvent.click(screen.getByRole('button', { name: 'Delete link to acme/web-store' }));
    confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    // Once confirmed, the backend has no more links.
    state.links = [];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE');
      expect(del).toBeTruthy();
    });
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('backendRepoId=10');
    expect(del.url).toContain('frontendRepoId=20');

    // Row is gone after the post-delete reload (card `.repo-name`, not the select option).
    await waitFor(() =>
      expect(screen.queryByText('acme/payments-api', { selector: '.repo-name' })).toBeNull(),
    );
  });

  it('(e) switches the submit label to "Update link" with the replace hint when the selected pair already exists', async () => {
    installFetch({ repos: REPOS, links: [link('l1', 10, 20)], failRepos: false });
    render(<LinkManager login="octocat" appSlug="guardrail-app" />);

    await screen.findByText('acme/payments-api', { selector: '.repo-name' });

    // Initially "Save link" (nothing selected).
    expect(screen.getByRole('button', { name: 'Save link' })).not.toBeNull();

    const selects = screen.getAllByRole('combobox');
    const [backendSelect, frontendSelect] = selects;
    if (!backendSelect || !frontendSelect) throw new Error('expected two selects');
    fireEvent.change(backendSelect, { target: { value: '10' } });
    fireEvent.change(frontendSelect, { target: { value: '20' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update link' })).not.toBeNull();
    });
    expect(
      screen.getByText('A link already exists for this pair — saving will replace it.'),
    ).not.toBeNull();
  });

  it('(f) announces "Link saved" and "Link deleted" in the aria-live region', async () => {
    const state: FetchState = { repos: REPOS, links: [], failRepos: false };
    installFetch(state);
    render(<LinkManager login="octocat" appSlug="guardrail-app" />);

    await screen.findByText('No links yet');
    const liveRegion = document.querySelector('[aria-live="polite"]')!;

    // Save a link.
    selectPair(10, 20);
    state.links = [link('l1', 10, 20)];
    fireEvent.click(screen.getByRole('button', { name: 'Save link' }));

    await waitFor(() => expect(liveRegion.textContent).toBe('Link saved.'));

    // Now delete it.
    fireEvent.click(screen.getByRole('button', { name: 'Delete link to acme/web-store' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    state.links = [];
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(liveRegion.textContent).toBe('Link deleted.'));
  });

  it('(g) sends the x-guardrail-request: dashboard CSRF header on every fetch', async () => {
    const state: FetchState = { repos: REPOS, links: [link('l1', 10, 20)], failRepos: false };
    const { calls } = installFetch(state);
    render(<LinkManager login="octocat" appSlug="guardrail-app" />);

    await screen.findByRole('button', { name: 'Delete link to acme/web-store' });

    // Create a link (POST) and delete one (DELETE) so all four verbs are exercised.
    selectPair(10, 20);
    // Pair (10,20) already exists → the submit button reads "Update link".
    fireEvent.click(screen.getByRole('button', { name: 'Update link' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Delete link to acme/web-store' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));

    // Every recorded call must carry the CSRF header.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.headers[CSRF_HEADER]).toBe('dashboard');
    }
  });
});
