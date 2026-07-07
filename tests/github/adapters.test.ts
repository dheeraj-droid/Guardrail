import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from 'octokit';
import {
  fetchFileText,
  listRepoTree,
  fetchBlobText,
  FileNotFoundError,
} from '@/lib/github/contents';
import {
  createInProgressCheckRun,
  concludeCheckRun,
  CHECK_NAME,
} from '@/lib/github/checks';
import { upsertPrComment, COMMENT_MARKER } from '@/lib/github/comments';

/**
 * Adapters use only `octokit.request(route, params)` (spec rationale), so a
 * `{ request: vi.fn() }` stub is a complete mock. `mockOctokit` returns that
 * stub typed as Octokit; the mock's implementation supplies each `{ data }`.
 */
function mockOctokit(): { octokit: Octokit; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  return { octokit: { request } as unknown as Octokit, request };
}

/** Base64-encode a UTF-8 string the way the GitHub API would. */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** An error shaped like an Octokit request failure. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('contents.ts — fetchFileText', () => {
  it('1a. decodes base64 file content to UTF-8', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: { content: b64('openapi: 3.0.0'), encoding: 'base64' } });

    const text = await fetchFileText(octokit, {
      owner: 'o',
      repo: 'r',
      path: 'openapi.json',
      ref: 'main',
    });

    expect(text).toBe('openapi: 3.0.0');
    const [route, params] = request.mock.calls[0]!;
    expect(route).toBe('GET /repos/{owner}/{repo}/contents/{path}');
    expect(params).toMatchObject({ owner: 'o', repo: 'r', path: 'openapi.json', ref: 'main' });
  });

  it('1b. maps a 404 to FileNotFoundError', async () => {
    const { octokit, request } = mockOctokit();
    request.mockRejectedValue(httpError(404));

    await expect(
      fetchFileText(octokit, { owner: 'o', repo: 'r', path: 'nope.json', ref: 'main' }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it('1c. treats an array (directory) response as FileNotFoundError', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: [{ name: 'a.json' }, { name: 'b.json' }] });

    await expect(
      fetchFileText(octokit, { owner: 'o', repo: 'r', path: 'dir', ref: 'main' }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it('1d. rethrows non-404 errors unchanged', async () => {
    const { octokit, request } = mockOctokit();
    request.mockRejectedValue(httpError(500));

    await expect(
      fetchFileText(octokit, { owner: 'o', repo: 'r', path: 'x.json', ref: 'main' }),
    ).rejects.not.toBeInstanceOf(FileNotFoundError);
  });
});

describe('contents.ts — listRepoTree', () => {
  it('2. filters tree entries to blobs and propagates truncated: true', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({
      data: {
        truncated: true,
        tree: [
          { path: 'src/a.ts', type: 'blob', sha: 'sha-a' },
          { path: 'src', type: 'tree', sha: 'sha-dir' },
          { path: 'src/b.ts', type: 'blob', sha: 'sha-b' },
        ],
      },
    });

    const result = await listRepoTree(octokit, { owner: 'o', repo: 'r', ref: 'deadbeef' });

    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([
      { path: 'src/a.ts', sha: 'sha-a' },
      { path: 'src/b.ts', sha: 'sha-b' },
    ]);
    const [route, params] = request.mock.calls[0]!;
    expect(route).toBe('GET /repos/{owner}/{repo}/git/trees/{tree_sha}');
    expect(params).toMatchObject({ owner: 'o', repo: 'r', tree_sha: 'deadbeef', recursive: '1' });
  });

  it('2b. defaults truncated to false when absent', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: { tree: [{ path: 'a.ts', type: 'blob', sha: 's' }] } });

    const result = await listRepoTree(octokit, { owner: 'o', repo: 'r', ref: 'main' });
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([{ path: 'a.ts', sha: 's' }]);
  });
});

describe('contents.ts — fetchBlobText', () => {
  it('3. decodes base64 blob content to UTF-8', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: { content: b64('const x = 1;'), encoding: 'base64' } });

    const text = await fetchBlobText(octokit, { owner: 'o', repo: 'r', fileSha: 'blob-sha' });

    expect(text).toBe('const x = 1;');
    const [route, params] = request.mock.calls[0]!;
    expect(route).toBe('GET /repos/{owner}/{repo}/git/blobs/{file_sha}');
    expect(params).toMatchObject({ owner: 'o', repo: 'r', file_sha: 'blob-sha' });
  });
});

describe('checks.ts — createInProgressCheckRun', () => {
  it('4. returns data.id and posts status in_progress with CHECK_NAME', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: { id: 987 } });

    const id = await createInProgressCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      headSha: 'abc123',
    });

    expect(id).toBe(987);
    const [route, params] = request.mock.calls[0]!;
    expect(route).toBe('POST /repos/{owner}/{repo}/check-runs');
    expect(params).toMatchObject({
      owner: 'o',
      repo: 'r',
      name: CHECK_NAME,
      head_sha: 'abc123',
      status: 'in_progress',
    });
    expect(typeof params.started_at).toBe('string');
  });
});

describe('checks.ts — concludeCheckRun', () => {
  it('5. sends completed status, the conclusion, and a summary <= 65535 chars', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: {} });

    const hugeSummary = 'x'.repeat(100_000);
    await concludeCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      checkRunId: 42,
      conclusion: 'failure',
      title: 'Breaking changes found',
      summary: hugeSummary,
    });

    const [route, params] = request.mock.calls[0]!;
    expect(route).toBe('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}');
    expect(params).toMatchObject({
      owner: 'o',
      repo: 'r',
      check_run_id: 42,
      status: 'completed',
      conclusion: 'failure',
    });
    expect(params.output.title).toBe('Breaking changes found');
    expect(params.output.summary.length).toBe(65535);
    expect(typeof params.completed_at).toBe('string');
  });

  it('5b. leaves a short summary untouched', async () => {
    const { octokit, request } = mockOctokit();
    request.mockResolvedValue({ data: {} });

    await concludeCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      checkRunId: 7,
      conclusion: 'success',
      title: 'All clear',
      summary: 'No breaking changes.',
    });

    const [, params] = request.mock.calls[0]!;
    expect(params.output.summary).toBe('No breaking changes.');
  });
});

describe('comments.ts — upsertPrComment', () => {
  const body = `${COMMENT_MARKER}\n## Guardrail report`;

  it('6a. PATCHes the existing marker comment when one is present', async () => {
    const { octokit, request } = mockOctokit();
    request
      .mockResolvedValueOnce({
        data: [
          { id: 1, body: 'unrelated chatter' },
          { id: 2, body: `${COMMENT_MARKER} previous run` },
        ],
      })
      .mockResolvedValueOnce({ data: {} });

    await upsertPrComment(octokit, { owner: 'o', repo: 'r', prNumber: 5, body });

    expect(request).toHaveBeenCalledTimes(2);
    const [listRoute] = request.mock.calls[0]!;
    expect(listRoute).toBe('GET /repos/{owner}/{repo}/issues/{issue_number}/comments');
    const [patchRoute, patchParams] = request.mock.calls[1]!;
    expect(patchRoute).toBe('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}');
    expect(patchParams).toMatchObject({ owner: 'o', repo: 'r', comment_id: 2, body });
  });

  it('6b. POSTs a new comment when no marker comment exists', async () => {
    const { octokit, request } = mockOctokit();
    request
      .mockResolvedValueOnce({ data: [{ id: 1, body: 'just a normal comment' }] })
      .mockResolvedValueOnce({ data: {} });

    await upsertPrComment(octokit, { owner: 'o', repo: 'r', prNumber: 5, body });

    expect(request).toHaveBeenCalledTimes(2);
    const [postRoute, postParams] = request.mock.calls[1]!;
    expect(postRoute).toBe('POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
    expect(postParams).toMatchObject({ owner: 'o', repo: 'r', issue_number: 5, body });
  });
});
