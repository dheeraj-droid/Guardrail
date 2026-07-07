// Track E — GitHub Adapters. PR issue-comment transport.
import type { Octokit } from 'octokit';

export const COMMENT_MARKER = '<!-- guardrail-report -->';

/**
 * Create OR update the single Guardrail comment on a PR (idempotent on
 * synchronize). The `body` must already contain COMMENT_MARKER (formatComment,
 * Track F, guarantees this) — this adapter does not append it.
 *
 * Lists the first page of PR comments (per_page 100 — v1), finds the first whose
 * body includes COMMENT_MARKER: found → PATCH that comment; else POST a new one.
 */
export async function upsertPrComment(
  octokit: Octokit,
  params: { owner: string; repo: string; prNumber: number; body: string },
): Promise<void> {
  const { owner, repo, prNumber, body } = params;

  const { data: comments } = await octokit.request(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { owner, repo, issue_number: prNumber, per_page: 100 },
  );

  const existing = Array.isArray(comments)
    ? comments.find(
        (c) => typeof c?.body === 'string' && c.body.includes(COMMENT_MARKER),
      )
    : undefined;

  if (existing) {
    await octokit.request(
      'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
      { owner, repo, comment_id: existing.id, body },
    );
    return;
  }

  await octokit.request(
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { owner, repo, issue_number: prNumber, body },
  );
}
