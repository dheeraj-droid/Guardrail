import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from 'octokit';
import { scanFrontendRepo } from '@/lib/scan/scanRepo';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Base64-encode a UTF-8 string the way the GitHub API would. */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const TARGETS = new Set(['phoneNumber']);

/**
 * Fixture tree (spec's Acceptance-tests fixture, verbatim):
 *  - src/a.ts               -> scannable, under `src`
 *  - src/deep/b.tsx         -> scannable, under `src` (nested)
 *  - src-legacy/c.ts        -> looks like a `src` prefix match on a naive startsWith,
 *                              but must NOT match (prefix + '/' boundary rule)
 *  - lib/d.ts               -> outside `src`; only in-scope at repo root
 *  - src/e.css              -> wrong extension
 *  - src/f.d.ts             -> type declaration, excluded even though it ends in `.ts`
 *  - src/node_modules/g.ts  -> node_modules segment, excluded
 *  - openapi.json           -> the spec file itself; excluded (and wrong extension anyway)
 *
 * Every excluded fixture's blob body still contains `phoneNumber` so that if a filtering
 * rule regresses, the resulting spurious match would be caught by the assertions below.
 */
const TREE_ENTRIES: ReadonlyArray<{ path: string; sha: string }> = [
  { path: 'src/a.ts', sha: 'sha-a' },
  { path: 'src/deep/b.tsx', sha: 'sha-b' },
  { path: 'src-legacy/c.ts', sha: 'sha-c' },
  { path: 'lib/d.ts', sha: 'sha-d' },
  { path: 'src/e.css', sha: 'sha-e' },
  { path: 'src/f.d.ts', sha: 'sha-f' },
  { path: 'src/node_modules/g.ts', sha: 'sha-g' },
  { path: 'openapi.json', sha: 'sha-openapi' },
];

const BLOB_CONTENTS: Readonly<Record<string, string>> = {
  'sha-a': 'user.phoneNumber;',
  'sha-b': 'const { phoneNumber: p } = u;',
  'sha-c': 'user.phoneNumber;',
  'sha-d': 'user.phoneNumber;',
  'sha-e': 'body { color: red; } /* phoneNumber */',
  'sha-f': 'export declare const phoneNumber: string;',
  'sha-g': 'user.phoneNumber;',
  'sha-openapi': '{"phoneNumber": "string"}',
};

interface FixtureOptions {
  treeTruncated?: boolean;
  failShas?: ReadonlySet<string>;
}

/** Mock `octokit.request` exactly as Track E's tests do: a single `{ request: vi.fn() }`. */
function mockOctokit(opts: FixtureOptions = {}) {
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
      return {
        data: {
          truncated: Boolean(opts.treeTruncated),
          tree: TREE_ENTRIES.map((entry) => ({ ...entry, type: 'blob' })),
        },
      };
    }
    if (route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}') {
      const sha = params.file_sha as string;
      if (opts.failShas?.has(sha)) {
        throw new Error(`blob fetch failed: ${sha}`);
      }
      return { data: { content: b64(BLOB_CONTENTS[sha] ?? ''), encoding: 'base64' } };
    }
    throw new Error(`Unexpected route: ${route}`);
  });
  const octokit = { request } as unknown as Octokit;
  return { octokit, request };
}

const baseOpts = {
  owner: 'o',
  repo: 'r',
  ref: 'main',
  openapiFilePath: 'openapi.json',
  targetFields: TARGETS,
  concurrency: 8,
  maxFiles: 2000,
};

describe('scanFrontendRepo', () => {
  it('1. fetches exactly the files under the src prefix; matches found in both; sorted order', async () => {
    const { octokit, request } = mockOctokit();

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: 'src',
    });

    const blobShas = request.mock.calls
      .filter(([route]) => route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}')
      .map(([, params]) => (params as { file_sha: string }).file_sha)
      .sort();
    expect(blobShas).toEqual(['sha-a', 'sha-b']);

    expect(report.scannedFileCount).toBe(2);
    expect(report.truncated).toBe(false);
    expect(report.matches).toHaveLength(2);
    // sorted: 'src/a.ts' < 'src/deep/b.tsx'
    expect(report.matches[0]).toMatchObject({
      filePath: 'src/a.ts',
      field: 'phoneNumber',
      kind: 'property-access',
    });
    // Alias law (Law 6): destructured `{ phoneNumber: p }` matches source key phoneNumber.
    expect(report.matches[1]).toMatchObject({
      filePath: 'src/deep/b.tsx',
      field: 'phoneNumber',
      kind: 'destructuring',
    });
  });

  it('2. prefix safety — src-legacy/c.ts is not scanned despite sharing the "src" prefix text', async () => {
    const { octokit, request } = mockOctokit();

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: 'src',
    });

    const blobShas = request.mock.calls
      .filter(([route]) => route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}')
      .map(([, params]) => (params as { file_sha: string }).file_sha);
    expect(blobShas).not.toContain('sha-c');
    expect(report.matches.some((m) => m.filePath === 'src-legacy/c.ts')).toBe(false);
  });

  it('3. monorepo root (srcDirectory "") scans lib/d.ts too, but still skips css/d.ts/node_modules/openapi.json', async () => {
    const { octokit } = mockOctokit();

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: '',
    });

    const scannedPaths = report.matches.map((m) => m.filePath);
    expect(scannedPaths).toContain('lib/d.ts');
    expect(scannedPaths).toContain('src-legacy/c.ts');
    expect(scannedPaths).not.toContain('src/e.css');
    expect(scannedPaths).not.toContain('src/f.d.ts');
    expect(scannedPaths).not.toContain('src/node_modules/g.ts');
    expect(scannedPaths).not.toContain('openapi.json');
    // a.ts, deep/b.tsx, src-legacy/c.ts, lib/d.ts
    expect(report.scannedFileCount).toBe(4);
  });

  it('4. maxFiles: 1 caps to a single scanned file and reports truncated: true', async () => {
    const { octokit } = mockOctokit();

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: 'src',
      maxFiles: 1,
    });

    expect(report.scannedFileCount).toBe(1);
    expect(report.truncated).toBe(true);
    expect(report.matches.every((m) => m.filePath === 'src/a.ts')).toBe(true);
  });

  it('5. a truncated tree response propagates to report.truncated', async () => {
    const { octokit } = mockOctokit({ treeTruncated: true });

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: 'src',
      maxFiles: 2000, // large enough that the cap itself would not truncate
    });

    expect(report.truncated).toBe(true);
  });

  it('6. one rejecting blob fetch skips its file but others still scan; no throw', async () => {
    const { octokit } = mockOctokit({ failShas: new Set(['sha-a']) });

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: 'src',
    });

    expect(report.scannedFileCount).toBe(1); // only deep/b.tsx succeeded
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0]!.filePath).toBe('src/deep/b.tsx');
    expect(report.truncated).toBe(false);
  });

  it('7. empty targetFields makes zero octokit calls', async () => {
    const { octokit, request } = mockOctokit();

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: 'src',
      targetFields: new Set(),
    });

    expect(request).not.toHaveBeenCalled();
    expect(report).toEqual({ matches: [], scannedFileCount: 0, truncated: false });
  });

  it('8. never fetches more than `concurrency` blobs at once', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts`, sha: `sha-f${i}` }));
    let active = 0;
    let maxActive = 0;

    const request = vi.fn(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
        return {
          data: {
            truncated: false,
            tree: entries.map((entry) => ({ ...entry, type: 'blob' })),
          },
        };
      }
      if (route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}') {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(15);
        active--;
        return { data: { content: b64('const x = 1;'), encoding: 'base64' } };
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    const octokit = { request } as unknown as Octokit;

    const report = await scanFrontendRepo({
      octokit,
      ...baseOpts,
      srcDirectory: 'src',
      concurrency: 2,
    });

    expect(maxActive).toBe(2);
    expect(report.scannedFileCount).toBe(6);
  });
});
