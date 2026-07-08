import { describe, it, expect } from 'vitest';
import { authorizeLink, type RepoAccess } from '@/lib/auth/authorize';

const BACKEND: RepoAccess = { id: 1, fullName: 'acme/backend', canAdminister: true };
const BACKEND_NO_ADMIN: RepoAccess = { id: 1, fullName: 'acme/backend', canAdminister: false };
const FRONTEND: RepoAccess = { id: 2, fullName: 'acme/frontend', canAdminister: false };

describe('authorizeLink', () => {
  it('10. backend not in accessible -> 404, does not leak existence', () => {
    const result = authorizeLink({
      backendRepoId: 999,
      frontendRepoId: 2,
      accessible: [FRONTEND],
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      reason: 'backend repository not found in your app installations',
    });
  });

  it('11. backend found but lacks admin/maintain -> 403', () => {
    const result = authorizeLink({
      backendRepoId: 1,
      frontendRepoId: 2,
      accessible: [BACKEND_NO_ADMIN, FRONTEND],
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: 'you need admin or maintain permission on the backend repository',
    });
  });

  it('12. frontend not in accessible -> 404', () => {
    const result = authorizeLink({
      backendRepoId: 1,
      frontendRepoId: 555,
      accessible: [BACKEND],
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      reason: 'frontend repository not found in your app installations',
    });
  });

  it('13. monorepo (backendRepoId === frontendRepoId) with admin -> ok', () => {
    const result = authorizeLink({
      backendRepoId: 1,
      frontendRepoId: 1,
      accessible: [BACKEND],
    });

    expect(result).toEqual({ ok: true, backend: BACKEND, frontend: BACKEND });
  });

  it('14. cross-repo happy path -> ok, carries both resolved RepoAccess records', () => {
    const result = authorizeLink({
      backendRepoId: 1,
      frontendRepoId: 2,
      accessible: [BACKEND, FRONTEND],
    });

    expect(result).toEqual({ ok: true, backend: BACKEND, frontend: FRONTEND });
  });
});
