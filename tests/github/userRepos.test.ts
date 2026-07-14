import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from 'octokit';
import { listAccessibleRepos, toRepoAccess, type AccessibleRepo } from '@/lib/github/userRepos';

/** Same `{ request: vi.fn() }` convention as Track E's adapters.test.ts. */
function mockOctokit(): { octokit: Octokit; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  return { octokit: { request } as unknown as Octokit, request };
}

function repo(overrides: {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
}) {
  return {
    id: overrides.id,
    full_name: overrides.full_name,
    name: overrides.name,
    owner: { login: overrides.owner },
    permissions: overrides.permissions,
  };
}

describe('listAccessibleRepos', () => {
  it('15. two installations: dedupes by repo id and maps admin/maintain/neither permissions', async () => {
    const { octokit, request } = mockOctokit();

    request.mockImplementation(async (route: string, params?: Record<string, unknown>) => {
      if (route === 'GET /user/installations') {
        return { data: { total_count: 2, installations: [{ id: 10 }, { id: 20 }] } };
      }
      if (route === 'GET /user/installations/{installation_id}/repositories') {
        if (params?.installation_id === 10) {
          return {
            data: {
              total_count: 2,
              repositories: [
                repo({ id: 1, full_name: 'acme/admin-repo', name: 'admin-repo', owner: 'acme', permissions: { admin: true, push: true, pull: true } }),
                repo({ id: 2, full_name: 'acme/maintain-repo', name: 'maintain-repo', owner: 'acme', permissions: { admin: false, maintain: true, push: true, pull: true } }),
              ],
            },
          };
        }
        if (params?.installation_id === 20) {
          return {
            data: {
              total_count: 2,
              repositories: [
                // Same repo id 1 again (shared across installations) — must be deduped,
                // keeping the FIRST occurrence (installation 10).
                repo({ id: 1, full_name: 'acme/admin-repo', name: 'admin-repo', owner: 'acme', permissions: { admin: true } }),
                repo({ id: 3, full_name: 'acme/read-only-repo', name: 'read-only-repo', owner: 'acme', permissions: { admin: false, maintain: false, push: false, pull: true } }),
              ],
            },
          };
        }
      }
      throw new Error(`unexpected request: ${route}`);
    });

    const repos = await listAccessibleRepos(octokit);

    expect(repos).toEqual<AccessibleRepo[]>([
      { id: 1, fullName: 'acme/admin-repo', owner: 'acme', name: 'admin-repo', canAdminister: true, installationId: 10 },
      { id: 2, fullName: 'acme/maintain-repo', owner: 'acme', name: 'maintain-repo', canAdminister: true, installationId: 10 },
      { id: 3, fullName: 'acme/read-only-repo', owner: 'acme', name: 'read-only-repo', canAdminister: false, installationId: 20 },
    ]);

    // Two installations -> exactly 3 requests total (1 installations call + 2 repo calls).
    expect(request).toHaveBeenCalledTimes(3);
    const [firstRoute, firstParams] = request.mock.calls[0]!;
    expect(firstRoute).toBe('GET /user/installations');
    expect(firstParams).toMatchObject({ per_page: 100 });
  });

  it('16. missing permissions object -> canAdminister false', async () => {
    const { octokit, request } = mockOctokit();

    request.mockImplementation(async (route: string) => {
      if (route === 'GET /user/installations') {
        return { data: { total_count: 1, installations: [{ id: 99 }] } };
      }
      if (route === 'GET /user/installations/{installation_id}/repositories') {
        return {
          data: {
            total_count: 1,
            repositories: [
              repo({ id: 42, full_name: 'acme/no-perms', name: 'no-perms', owner: 'acme' }),
            ],
          },
        };
      }
      throw new Error(`unexpected request: ${route}`);
    });

    const repos = await listAccessibleRepos(octokit);

    expect(repos).toEqual<AccessibleRepo[]>([
      { id: 42, fullName: 'acme/no-perms', owner: 'acme', name: 'no-perms', canAdminister: false, installationId: 99 },
    ]);
  });
});

describe('toRepoAccess', () => {
  it('maps an AccessibleRepo to the RepoAccess shape authorizeLink expects', () => {
    const accessible: AccessibleRepo = {
      id: 7,
      fullName: 'acme/repo',
      owner: 'acme',
      name: 'repo',
      canAdminister: true,
      installationId: 1,
    };

    expect(toRepoAccess(accessible)).toEqual({ id: 7, fullName: 'acme/repo', canAdminister: true });
  });
});
