// Spec L, File 2 — cross-file $ref resolution orchestration (Spec E extension, IO shell).
// Law 2: this file (not resolveRefs.ts) owns all IO — Contents API fetches, bounded
// concurrency, and the cross-file depth/cycle guard.
// Law 9: bulk fetches route through mapWithConcurrency, never Promise.all/sequential.
// Law 11: Contents API stays inside its documented exception (spec files only).

import type { Octokit } from 'octokit';
import { fetchFileText } from '@/lib/github/contents';
import { parseOpenApiSpec } from '@/lib/diff/parseSpec';
import { mapWithConcurrency } from '@/lib/scan/concurrency';
import { findExternalRefs, mergeExternalRefs, type ExternalRef } from '@/lib/diff/resolveRefs';

/** Everything before the last `/`, or '' for a root-level file (no path module — Law 13). */
function dirname(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

/**
 * Orchestrate: find this spec's external file refs, fetch each target via the Contents
 * API (Law 11's Contents exception already covers spec files — this stays inside that
 * exception, never switches to Blobs), parse each as an OpenAPI doc, recurse into
 * refs found INSIDE those documents up to maxDepth, then structurally merge everything
 * back into the root spec. Returns the root spec unchanged if there are no external
 * refs (zero extra API calls — same "don't do work you don't need" principle as
 * scanRepo.ts's targetFields.size === 0 short-circuit).
 */
export async function resolveSpecRefs(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    ref: string; // same ref/sha the root spec itself was fetched at
    rootSpec: Record<string, unknown>;
    rootPath: string; // e.g. link.openapi_file_path — used as basePath for the root walk
    maxDepth: number; // env.maxRefResolutionDepth
    concurrency: number; // env.scanConcurrency — reuse, do not invent a third concurrency knob
  },
): Promise<Record<string, unknown>> {
  const { owner, repo, ref, rootSpec, rootPath, maxDepth, concurrency } = params;

  // Step 1: find the root document's own external refs.
  const initialRefs = findExternalRefs(rootSpec, dirname(rootPath));

  // Step 2: short-circuit — zero fetches when there is nothing external to resolve.
  if (initialRefs.length === 0) {
    return rootSpec;
  }

  const resolved = new Map<string, Record<string, unknown>>();
  // Step 5: cross-file cycle guard, seeded with the root document itself.
  const visited = new Set<string>([rootPath]);

  /** Fetch+parse+recurse one "level" of external refs, breadth-first, depth-bounded. */
  async function resolveLevel(refs: readonly ExternalRef[], currentDepth: number): Promise<void> {
    if (refs.length === 0) return;
    // Step 5 (depth half): refs found at/after the cap are left unresolved, never thrown.
    if (currentDepth >= maxDepth) return;

    // Dedup against already-visited targets and against duplicates within this level.
    const targets: ExternalRef[] = [];
    const seenThisLevel = new Set<string>();
    for (const r of refs) {
      if (visited.has(r.filePath)) continue;
      if (seenThisLevel.has(r.filePath)) continue;
      seenThisLevel.add(r.filePath);
      targets.push(r);
    }
    if (targets.length === 0) return;

    // Mark visited before fetching so a cycle discovered within this same batch (or a
    // ref back to something already resolved) never triggers a second fetch.
    for (const target of targets) visited.add(target.filePath);

    // Step 3+4: bounded-concurrency fetch + parse. Per-target failure (404, malformed
    // YAML/JSON, or any other fetch error) drops that ref — never aborts the others.
    const fetchedDocs = await mapWithConcurrency(targets, concurrency, async (target) => {
      try {
        const text = await fetchFileText(octokit, { owner, repo, path: target.filePath, ref });
        const doc = parseOpenApiSpec(text, target.filePath);
        return { filePath: target.filePath, doc };
      } catch {
        return null;
      }
    });

    // Step 6: recurse into each successfully parsed document's own external refs.
    const nextLevelRefs: ExternalRef[] = [];
    for (const entry of fetchedDocs) {
      if (entry === null) continue;
      resolved.set(entry.filePath, entry.doc);
      nextLevelRefs.push(...findExternalRefs(entry.doc, dirname(entry.filePath)));
    }

    await resolveLevel(nextLevelRefs, currentDepth + 1);
  }

  await resolveLevel(initialRefs, 0);

  // Step 7: one final structural merge with the full (possibly multi-level) map.
  return mergeExternalRefs(rootSpec, resolved);
}
