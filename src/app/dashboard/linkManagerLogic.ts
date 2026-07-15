// Spec K / T11 — PURE dashboard view-logic helpers, extracted from LinkManager.tsx so
// they can be unit-tested in a node env (no React, no DOM, no IO). Everything here is a
// deterministic function of its inputs.

import type { AccessibleRepo } from '@/lib/github/userRepos';
import type { ProjectLinkRow } from '@/lib/db/linkAdmin';

/**
 * The label for a repo id given the repos the signed-in user can currently reach. When the
 * id is not in that set — the App may have been uninstalled from it, or the user lost
 * access — fall back to a stable, human-readable placeholder rather than a bare number.
 */
export function repoFullName(repos: readonly AccessibleRepo[], id: number): string {
  const repo = repos.find((r) => r.id === id);
  return repo ? repo.fullName : `Repository ${id} (no access)`;
}

/** True when `repoFullName` returned the "no access" fallback for this id. */
export function isUnknownRepo(repos: readonly AccessibleRepo[], id: number): boolean {
  return !repos.some((r) => r.id === id);
}

/**
 * Does a link already exist for the selected backend+frontend PAIR? Drives the
 * "Save link" vs "Update link" affordance — an upsert on an existing pair replaces it.
 * Ids are compared numerically; empty/NaN selections never match.
 */
export function findExistingLink(
  links: readonly ProjectLinkRow[],
  backendRepoId: number,
  frontendRepoId: number,
): ProjectLinkRow | undefined {
  if (!Number.isInteger(backendRepoId) || !Number.isInteger(frontendRepoId)) return undefined;
  if (backendRepoId <= 0 || frontendRepoId <= 0) return undefined;
  return links.find(
    (l) => l.backend_repo_id === backendRepoId && l.frontend_repo_id === frontendRepoId,
  );
}

/** A backend repo and its frontend link rows — the grouped-list view model. */
export interface BackendGroup {
  backendRepoId: number;
  /** All links for this backend, insertion-order preserved from the input list. */
  links: ProjectLinkRow[];
}

/**
 * Group links by their backend repo id, preserving first-seen order for both the groups
 * and the rows within each group (stable, so the list does not reshuffle on re-render).
 */
export function groupLinksByBackend(links: readonly ProjectLinkRow[]): BackendGroup[] {
  const groups: BackendGroup[] = [];
  const byId = new Map<number, BackendGroup>();

  for (const link of links) {
    let group = byId.get(link.backend_repo_id);
    if (!group) {
      group = { backendRepoId: link.backend_repo_id, links: [] };
      byId.set(link.backend_repo_id, group);
      groups.push(group);
    }
    group.links.push(link);
  }

  return groups;
}

/** Stable key for the confirming/deleting state — one link is one (backend, frontend) pair. */
export function pairKey(backendRepoId: number, frontendRepoId: number): string {
  return `${backendRepoId}:${frontendRepoId}`;
}

/** Count of distinct backend repos across the links — the "protected backends" stat. */
export function countProtectedBackends(links: readonly ProjectLinkRow[]): number {
  return new Set(links.map((l) => l.backend_repo_id)).size;
}
