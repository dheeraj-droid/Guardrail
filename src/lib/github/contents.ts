// Track E — GitHub Adapters. Contents + Git Trees/Blobs transport (CLAUDE.md Law 11).
// Thin adapters: translate domain inputs to Octokit requests, no business logic.
import type { Octokit } from 'octokit';

/** Thrown when a spec file is missing or the path resolves to a directory. */
export class FileNotFoundError extends Error {
  constructor(
    readonly path: string,
    readonly ref: string,
  ) {
    super(`File not found: ${path} @ ${ref}`);
    this.name = 'FileNotFoundError';
  }
}

/**
 * Fetch one file's UTF-8 text at a ref. Contents API — OpenAPI spec files ONLY
 * (Law 11). Throws FileNotFoundError on 404 or when the path is not a file.
 */
export async function fetchFileText(
  octokit: Octokit,
  params: { owner: string; repo: string; path: string; ref: string },
): Promise<string> {
  const { owner, repo, path, ref } = params;
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner, repo, path, ref },
    );
    // Array response = directory; object without `content` = submodule/symlink/etc.
    if (Array.isArray(data) || data === null || typeof data !== 'object' || !('content' in data) || typeof data.content !== 'string') {
      throw new FileNotFoundError(path, ref);
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (error instanceof FileNotFoundError) throw error;
    if (isStatus(error, 404)) throw new FileNotFoundError(path, ref);
    throw error;
  }
}

export interface RepoTreeFile {
  path: string;
  sha: string;
}

/**
 * One recursive tree call (Law 11): `git/trees/{ref}?recursive=1`. `ref` may be
 * a sha OR a branch name (GitHub accepts both). Returns blobs only plus the
 * server's truncation flag.
 */
export async function listRepoTree(
  octokit: Octokit,
  params: { owner: string; repo: string; ref: string },
): Promise<{ files: RepoTreeFile[]; truncated: boolean }> {
  const { owner, repo, ref } = params;
  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    { owner, repo, tree_sha: ref, recursive: '1' },
  );

  const tree = Array.isArray(data.tree) ? data.tree : [];
  const files: RepoTreeFile[] = [];
  for (const entry of tree) {
    if (entry.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string') {
      files.push({ path: entry.path, sha: entry.sha });
    }
  }
  return { files, truncated: Boolean(data.truncated) };
}

/**
 * Fetch a blob by sha and decode base64 → UTF-8 (Law 11: bypasses the Contents
 * API 1 MB cap for frontend source files).
 */
export async function fetchBlobText(
  octokit: Octokit,
  params: { owner: string; repo: string; fileSha: string },
): Promise<string> {
  const { owner, repo, fileSha } = params;
  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/git/blobs/{file_sha}',
    { owner, repo, file_sha: fileSha },
  );
  return Buffer.from(data.content, 'base64').toString('utf8');
}

function isStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === status
  );
}
