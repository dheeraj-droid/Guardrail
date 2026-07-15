import { describe, it, expect } from 'vitest';
import type { AccessibleRepo } from '@/lib/github/userRepos';
import type { ProjectLinkRow } from '@/lib/db/linkAdmin';
import {
  repoFullName,
  isUnknownRepo,
  findExistingLink,
  groupLinksByBackend,
  pairKey,
  countProtectedBackends,
} from '@/app/dashboard/linkManagerLogic';

function repo(id: number, fullName: string, canAdminister = true): AccessibleRepo {
  return { id, fullName, owner: 'acme', name: fullName.split('/')[1] ?? fullName, canAdminister, installationId: 1 };
}

function link(
  id: string,
  backend: number,
  frontend: number,
  spec = 'openapi.json',
  src = 'src',
): ProjectLinkRow {
  return {
    id,
    backend_repo_id: backend,
    frontend_repo_id: frontend,
    openapi_file_path: spec,
    frontend_src_directory: src,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

const repos: AccessibleRepo[] = [
  repo(10, 'acme/payments-api'),
  repo(20, 'acme/web-store'),
  repo(30, 'acme/catalog-api'),
];

describe('repoFullName', () => {
  it('returns the fullName for a known repo', () => {
    expect(repoFullName(repos, 10)).toBe('acme/payments-api');
  });

  it('falls back to a no-access placeholder for an unknown id', () => {
    expect(repoFullName(repos, 999)).toBe('Repository 999 (no access)');
  });

  it('handles an empty repo list', () => {
    expect(repoFullName([], 5)).toBe('Repository 5 (no access)');
  });
});

describe('isUnknownRepo', () => {
  it('is false for a reachable repo', () => {
    expect(isUnknownRepo(repos, 20)).toBe(false);
  });

  it('is true for an unreachable repo', () => {
    expect(isUnknownRepo(repos, 777)).toBe(true);
  });
});

describe('findExistingLink', () => {
  const links = [link('a', 10, 20), link('b', 10, 30), link('c', 30, 30)];

  it('finds the link for an existing pair', () => {
    expect(findExistingLink(links, 10, 30)?.id).toBe('b');
  });

  it('returns undefined when the pair does not exist', () => {
    expect(findExistingLink(links, 10, 99)).toBeUndefined();
  });

  it('matches on the exact pair, not just the backend', () => {
    // backend 10 exists, but not paired to frontend 40.
    expect(findExistingLink(links, 10, 40)).toBeUndefined();
  });

  it('returns undefined for invalid (zero/NaN) selections', () => {
    expect(findExistingLink(links, 0, 20)).toBeUndefined();
    expect(findExistingLink(links, 10, Number.NaN)).toBeUndefined();
    expect(findExistingLink(links, -1, 20)).toBeUndefined();
  });
});

describe('groupLinksByBackend', () => {
  it('groups links under their backend repo, preserving first-seen order', () => {
    const links = [link('a', 10, 20), link('b', 30, 30), link('c', 10, 30)];
    const groups = groupLinksByBackend(links);
    expect(groups.map((g) => g.backendRepoId)).toEqual([10, 30]);
    expect(groups[0]?.links.map((l) => l.id)).toEqual(['a', 'c']);
    expect(groups[1]?.links.map((l) => l.id)).toEqual(['b']);
  });

  it('returns an empty array for no links', () => {
    expect(groupLinksByBackend([])).toEqual([]);
  });

  it('keeps a single-frontend backend as one group with one row', () => {
    const groups = groupLinksByBackend([link('a', 10, 20)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.links).toHaveLength(1);
  });
});

describe('pairKey', () => {
  it('encodes a backend/frontend pair as a stable string', () => {
    expect(pairKey(10, 20)).toBe('10:20');
  });

  it('distinguishes pairs that share a backend', () => {
    expect(pairKey(10, 20)).not.toBe(pairKey(10, 30));
  });
});

describe('countProtectedBackends', () => {
  it('counts distinct backend repos', () => {
    const links = [link('a', 10, 20), link('b', 10, 30), link('c', 30, 30)];
    expect(countProtectedBackends(links)).toBe(2);
  });

  it('is zero for no links', () => {
    expect(countProtectedBackends([])).toBe(0);
  });
});
