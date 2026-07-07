# Spec E — GitHub Adapters (client, contents, checks, comments)

**Wave:** 1 | **Agent:** module-builder | **Depends on:** W0
**Files produced (in order):** `src/lib/github/client.ts`, `contents.ts`, `checks.ts`,
`comments.ts`. Tests: `tests/github/adapters.test.ts`.

## Purpose
Every GitHub REST interaction in one directory. Thin adapters: translate our domain
inputs to Octokit calls; no business logic, no verdict decisions here.

## File 1 — client.ts  (Law 3 — THE auth chokepoint)
```ts
import { App, Octokit } from 'octokit';
import type { Env } from '@/config/env';

/** Octokit authenticated AS THE APP INSTALLATION from the webhook payload. */
export async function getInstallationClient(env: Env, installationId: number): Promise<Octokit>;
```
- `new App({ appId: env.githubAppId, privateKey: env.githubAppPrivateKey })`
  then `app.getInstallationOctokit(installationId)`.
- WHY (write this comment): check runs can only be created by GitHub Apps; a PAT yields
  403. The installation token also grants access to every repo in the installation —
  which is how ONE client reads the frontend repo AND writes checks to the backend repo.
- No caching in v1 (tokens expire hourly; App handles renewal internally).

## File 2 — contents.ts  (Contents API — OpenAPI spec files ONLY, Law 11)
```ts
export class FileNotFoundError extends Error {
  constructor(readonly path: string, readonly ref: string);
}
/** Fetch one file's UTF-8 text at a ref. Throws FileNotFoundError on 404/non-file. */
export async function fetchFileText(
  octokit: Octokit,
  params: { owner: string; repo: string; path: string; ref: string },
): Promise<string>;

export interface RepoTreeFile { path: string; sha: string }
/** One recursive tree call (Law 11). Returns blobs only + truncation flag. */
export async function listRepoTree(
  octokit: Octokit,
  params: { owner: string; repo: string; ref: string },
): Promise<{ files: RepoTreeFile[]; truncated: boolean }>;

/** Fetch a blob by sha and decode base64 → UTF-8 (Law 11: no 1MB Contents cap). */
export async function fetchBlobText(
  octokit: Octokit,
  params: { owner: string; repo: string; fileSha: string },
): Promise<string>;
```
Implementation notes:
- fetchFileText: `GET /repos/{owner}/{repo}/contents/{path}?ref=...`. Response may be an
  array (directory) or lack `content` — treat both as FileNotFoundError. Decode
  `Buffer.from(data.content, 'base64').toString('utf8')`. Catch Octokit 404
  (`error.status === 404`) → FileNotFoundError; rethrow anything else.
- listRepoTree: `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` — `ref` may be a
  sha OR branch name (GitHub accepts both). Filter `type === 'blob'` and non-null path.
  `truncated` comes straight off the response.
- fetchBlobText: `GET /repos/{owner}/{repo}/git/blobs/{file_sha}` → base64 decode.

## File 3 — checks.ts  (SRD §4 transport)
```ts
import type { CheckConclusion } from '@/types/contract';
export const CHECK_NAME = 'Guardrail Contract Check';

/** Create the run in_progress as soon as processing starts; returns check_run id. */
export async function createInProgressCheckRun(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string },
): Promise<number>;

/** Conclude the run. Summary is truncated here via truncateForChecks (Law 15). */
export async function concludeCheckRun(
  octokit: Octokit,
  params: { owner: string; repo: string; checkRunId: number;
            conclusion: CheckConclusion; title: string; summary: string },
): Promise<void>;
```
- create: `POST /repos/{owner}/{repo}/check-runs` with `{ name: CHECK_NAME, head_sha,
  status: 'in_progress', started_at: new Date().toISOString() }`.
- conclude: `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` with
  `{ status: 'completed', completed_at: ..., conclusion, output: { title, summary:
  truncateForChecks(summary) } }`. Import `truncateForChecks` from `@/lib/report/formatComment`
  (Track F owns it; its signature is frozen in that spec — safe cross-track import, it is
  Wave-1-internal but only used at runtime, and the wave gate compiles everything together.
  If you finish before Track F, declare the import anyway; the GATE, not you, verifies compile).

## File 4 — comments.ts
```ts
export const COMMENT_MARKER = '<!-- guardrail-report -->';
/** Create OR update the single Guardrail comment on a PR (idempotent on synchronize). */
export async function upsertPrComment(
  octokit: Octokit,
  params: { owner: string; repo: string; prNumber: number; body: string },
): Promise<void>;
```
- Body passed in must already contain COMMENT_MARKER (formatComment guarantees it; do not
  append it here).
- List `GET /repos/{owner}/{repo}/issues/{prNumber}/comments` (per_page 100, first page
  only — v1), find first comment whose body includes COMMENT_MARKER:
  found → `PATCH /repos/{owner}/{repo}/issues/comments/{id}`; else
  `POST /repos/{owner}/{repo}/issues/{prNumber}/comments`.

## Acceptance tests (adapters.test.ts)
Mock octokit as `{ request: vi.fn() }`-shaped objects (Octokit's `.request(route, params)`
is the only method you may use in adapters — uniform + trivially mockable; do NOT use
`octokit.rest.*` sugar, it complicates mocks).
1. fetchFileText decodes base64 content; 404 → FileNotFoundError; array response → FileNotFoundError.
2. listRepoTree filters tree entries to blobs, propagates `truncated: true`.
3. fetchBlobText decodes base64.
4. createInProgressCheckRun returns `data.id`; asserts posted `status: 'in_progress'`
   and `name: CHECK_NAME`.
5. concludeCheckRun sends `status: 'completed'`, the conclusion, and a summary ≤ 65535
   chars even when given a 100k-char input.
6. upsertPrComment PATCHes when a marker comment exists; POSTs when none does.

## Forbidden
- `octokit.rest.*` / `octokit.paginate` (use `.request` only — see test rationale).
- Business logic: no verdict mapping, no markdown building, no file filtering here.
- Retry loops (v1 relies on Octokit's built-in retry/throttle defaults).
