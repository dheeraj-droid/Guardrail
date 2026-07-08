// Spec K — user-token adapter (dashboard only). `octokit.request` only, same convention
// as Track E (CLAUDE.md: no octokit.rest.*, no paginate).
import type { Octokit } from 'octokit';
import type { RepoAccess } from '@/lib/auth/authorize';

export interface AccessibleRepo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  canAdminister: boolean;
  installationId: number;
}

/**
 * Repos the signed-in user can reach THROUGH an App installation. This intersection (App
 * installed on the repo AND the user has explicit access to it) is the security primitive
 * of the whole dashboard feature: a user can never enumerate — let alone link — a repo the
 * App cannot also see server-side.
 *
 * v1: first page only (per_page 100) of both endpoints.
 */
export async function listAccessibleRepos(octokit: Octokit): Promise<AccessibleRepo[]> {
  const { data: installationsData } = await octokit.request('GET /user/installations', {
    per_page: 100,
  });

  const seen = new Set<number>();
  const repos: AccessibleRepo[] = [];

  for (const installation of installationsData.installations) {
    const { data: reposData } = await octokit.request(
      'GET /user/installations/{installation_id}/repositories',
      { installation_id: installation.id, per_page: 100 },
    );

    for (const repo of reposData.repositories) {
      if (seen.has(repo.id)) continue; // dedupe by repo id — keep the first occurrence
      seen.add(repo.id);

      const permissions = repo.permissions;
      const canAdminister = permissions?.admin === true || permissions?.maintain === true;

      repos.push({
        id: repo.id,
        fullName: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        canAdminister,
        installationId: installation.id,
      });
    }
  }

  return repos;
}

/** Adapt an AccessibleRepo to the shape authorizeLink() expects. */
export function toRepoAccess(r: AccessibleRepo): RepoAccess {
  return { id: r.id, fullName: r.fullName, canAdminister: r.canAdminister };
}
