# Spec G — Frontend Repo Scan Orchestration

**Wave:** 2 | **Agent:** module-builder | **Depends on:** C (concurrency, astScanner), E (contents)
**Files produced:** `src/lib/scan/scanRepo.ts`, `tests/scan/scanRepo.test.ts`
**Gate note (Law 12):** run ONLY `npx vitest run tests/scan/scanRepo.test.ts` — the global
gate compiles the whole wave.

## Purpose
The IO half of SRD Module 4 + the concurrency edge case (SRD §3): list the frontend tree
once, filter to scannable files under the configured source directory, fetch blobs with
bounded concurrency, AST-scan each, aggregate a `ScanReport`.

## Public API (exact)
```ts
import type { Octokit } from 'octokit';
import type { ScanReport } from '@/types/contract';

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
  concurrency: number;      // env.scanConcurrency
  maxFiles: number;         // env.maxScanFiles
}): Promise<ScanReport>;
```

## Implementation steps
1. Short-circuit: `targetFields.size === 0` → `{ matches: [], scannedFileCount: 0, truncated: false }`
   (no API calls at all).
2. `const { files, truncated: treeTruncated } = await listRepoTree(octokit, { owner, repo, ref });`
   — exactly ONE tree call (Law 11).
3. **normalizePrefix(srcDirectory):** trim; strip leading `./`; strip leading and trailing
   `/`; result `''` means repo root. Non-empty prefix matches when
   `path === prefix || path.startsWith(prefix + '/')` — NEVER bare `startsWith(prefix)`
   (`src` must not match `src-legacy/…`). This function is the ONLY place prefix scoping
   happens (Law 8 — monorepo routing by subdirectory offset).
4. Filter `files` (order matters for determinism — keep tree order):
   a. under prefix (step 3);
   b. extension ∈ `.ts .tsx .js .jsx`;
   c. NOT ending `.d.ts` (type declarations are not runtime UI usage);
   d. path does not contain a `node_modules/` segment;
   e. `path !== normalized openapiFilePath` (monorepo: never scan the spec itself).
5. Cap: `capped = filtered.slice(0, maxFiles)`; `capTruncated = filtered.length > maxFiles`.
6. Fetch + scan with the bounded pool (Law 9):
   ```ts
   const perFile = await mapWithConcurrency(capped, concurrency, async (file) => {
     try {
       const text = await fetchBlobText(octokit, { owner, repo, fileSha: file.sha });
       return scanSourceForFields({ filePath: file.path, sourceText: text, targetFields });
     } catch { return null; }   // per-file resilience: a failed blob skips that file
   });
   ```
   Count `failedFiles = perFile.filter(r => r === null).length`.
7. Return:
   - `matches`: flatten non-null results; sort by filePath asc, line asc, column asc.
   - `scannedFileCount`: capped.length − failedFiles.
   - `truncated`: `treeTruncated || capTruncated`.

## Acceptance tests (mock `octokit.request` exactly as Track E's tests do)
Craft a fake tree containing: `src/a.ts`, `src/deep/b.tsx`, `src-legacy/c.ts`, `lib/d.ts`,
`src/e.css`, `src/f.d.ts`, `src/node_modules/g.ts`, `openapi.json`, plus blob fixtures where
`a.ts` = `user.phoneNumber;` and `b.tsx` = `const { phoneNumber: p } = u;`.
1. With srcDirectory `src`, openapiFilePath `openapi.json`: exactly `a.ts` and `deep/b.tsx`
   are fetched (assert the mock's blob-call paths/shas); matches found in both; sorted order.
2. Prefix safety: `src-legacy/c.ts` NOT scanned (the `prefix + '/'` rule).
3. Monorepo root: srcDirectory `''` (after normalize) scans `lib/d.ts` too but still skips
   css/d.ts/node_modules/openapi.json.
4. `maxFiles: 1` → 1 file scanned, `truncated: true`.
5. Tree response `truncated: true` → report `truncated: true`.
6. One blob fetch rejects → its file skipped, others still scanned,
   `scannedFileCount` excludes it, no throw.
7. Empty targetFields → zero octokit calls (assert mock not called).
8. Concurrency: with 6 files and concurrency 2, max in-flight blob fetches observed ≤ 2
   (instrument the mock with an active counter).

## Forbidden
- Fetching file content via the Contents API (Law 11).
- Sequential awaits in a loop over files, or unbounded `Promise.all` (Law 9).
- Any additional filtering knobs (test dirs, gitignore) — not in SRD; keep to the five
  filter rules above.
