// Spec G — Frontend Repo Scan Orchestration (SRD Module 4, IO half).
// This file is the IO shell for scan/ (Law 2 permits IO here only, not in
// astScanner.ts/concurrency.ts): it wires the pure AST scanner and the bounded
// concurrency pool to the Git Trees/Blobs adapters from github/contents.ts.
// Law 8: this is the ONLY place frontend_src_directory prefix scoping happens.
// Law 9: bulk blob fetches route through mapWithConcurrency — never Promise.all
// over the file list, never sequential awaits in a loop.
// Law 11: exactly one recursive git/trees call for listing; Git Blobs API (not
// Contents API) for file bodies.

import type { Octokit } from 'octokit';
import type { ScanReport, UsageMatch } from '@/types/contract';
import { listRepoTree, fetchBlobText } from '@/lib/github/contents';
import { mapWithConcurrency } from '@/lib/scan/concurrency';
import { scanSourceForFields } from '@/lib/scan/astScanner';

/** Runtime source extensions the AST scanner understands (SRD Module 4). */
const SCANNABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;

export async function scanFrontendRepo(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** Branch name or commit sha — passed straight to listRepoTree. */
  ref: string;
  /** ProjectLink.frontend_src_directory, e.g. "src" or "apps/web/src". */
  srcDirectory: string;
  /** ProjectLink.openapi_file_path — excluded from scanning (monorepo case). */
  openapiFilePath: string;
  targetFields: ReadonlySet<string>;
  concurrency: number; // env.scanConcurrency
  maxFiles: number; // env.maxScanFiles
}): Promise<ScanReport> {
  const {
    octokit,
    owner,
    repo,
    ref,
    srcDirectory,
    openapiFilePath,
    targetFields,
    concurrency,
    maxFiles,
  } = opts;

  // Step 1: short-circuit — nothing to look for, so make zero API calls.
  if (targetFields.size === 0) {
    return { matches: [], scannedFileCount: 0, truncated: false };
  }

  // Step 2: exactly ONE tree call (Law 11).
  const { files, truncated: treeTruncated } = await listRepoTree(octokit, { owner, repo, ref });

  // Step 3: normalize the source-directory prefix and the openapi path the same way, so
  // both are compared against tree paths (which never carry a leading './' or '/').
  const normalizedSrcPrefix = normalizePrefix(srcDirectory);
  const normalizedOpenapiPath = normalizePrefix(openapiFilePath);

  // Step 4: filter, preserving tree order for deterministic output.
  const filtered = files.filter((file) => {
    if (!isUnderPrefix(file.path, normalizedSrcPrefix)) return false; // (a) under prefix
    if (!hasScannableExtension(file.path)) return false; // (b)+(c): .ts/.tsx/.js/.jsx, not .d.ts
    if (hasNodeModulesSegment(file.path)) return false; // (d) no node_modules/ segment
    if (file.path === normalizedOpenapiPath) return false; // (e) never scan the spec itself
    return true;
  });

  // Step 5: cap.
  const capped = filtered.slice(0, maxFiles);
  const capTruncated = filtered.length > maxFiles;

  // Step 6: fetch + scan with the bounded pool (Law 9). Per-file resilience: a failed blob
  // fetch (or a throwing scan) skips only that file — it never fails the whole scan.
  const perFile = await mapWithConcurrency(capped, concurrency, async (file) => {
    try {
      const text = await fetchBlobText(octokit, { owner, repo, fileSha: file.sha });
      return scanSourceForFields({ filePath: file.path, sourceText: text, targetFields });
    } catch {
      return null;
    }
  });

  const failedFiles = perFile.filter((result) => result === null).length;

  // Step 7: aggregate.
  const matches: UsageMatch[] = perFile
    .filter((result): result is UsageMatch[] => result !== null)
    .flat()
    .sort(compareMatches);

  return {
    matches,
    scannedFileCount: capped.length - failedFiles,
    truncated: treeTruncated || capTruncated,
  };
}

/**
 * Trim; strip a leading './'; strip leading and trailing '/'. Result '' means repo root.
 * This is the ONLY place frontend_src_directory prefix scoping happens (Law 8).
 */
function normalizePrefix(input: string): string {
  let value = input.trim();
  if (value.startsWith('./')) {
    value = value.slice(2);
  }
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * '' (repo root) matches every path. A non-empty prefix matches only at a path-segment
 * boundary — `path === prefix` or `path.startsWith(prefix + '/')` — NEVER a bare
 * `startsWith(prefix)`, which would let `src` wrongly match `src-legacy/...`.
 */
function isUnderPrefix(path: string, prefix: string): boolean {
  if (prefix === '') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Extension allow-list minus `.d.ts` (type declarations are not runtime UI usage). */
function hasScannableExtension(path: string): boolean {
  if (path.endsWith('.d.ts')) return false;
  return SCANNABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** True if any path segment is exactly `node_modules` (substring match is not enough). */
function hasNodeModulesSegment(path: string): boolean {
  return path.split('/').includes('node_modules');
}

/** filePath asc, then line asc, then column asc. */
function compareMatches(a: UsageMatch, b: UsageMatch): number {
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}
