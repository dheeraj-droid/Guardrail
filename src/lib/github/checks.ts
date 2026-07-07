// Track E — GitHub Adapters. Checks API transport (SRD §4).
import type { Octokit } from 'octokit';
import type { CheckConclusion } from '@/types/contract';

export const CHECK_NAME = 'Guardrail Contract Check';

// GitHub Checks output.summary hard limit (Law 15). Defensive belt-and-suspenders
// cap only — the rich, newline-aware truncateForChecks (Track F) is applied
// UPSTREAM by the pipeline (Track H). This slice keeps the transport from ever
// 422-ing regardless of caller behaviour.
const CHECKS_SUMMARY_MAX = 65535;

/** Create the run in_progress as soon as processing starts; returns check_run id. */
export async function createInProgressCheckRun(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string },
): Promise<number> {
  const { owner, repo, headSha } = params;
  const { data } = await octokit.request(
    'POST /repos/{owner}/{repo}/check-runs',
    {
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    },
  );
  return data.id;
}

/**
 * Conclude the run. Summary is defensively capped here to 65,535 chars (Law 15,
 * DECOUPLING RULE — no import from @/lib/report).
 */
export async function concludeCheckRun(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: CheckConclusion;
    title: string;
    summary: string;
  },
): Promise<void> {
  const { owner, repo, checkRunId, conclusion, title, summary } = params;
  const safe = summary.length > CHECKS_SUMMARY_MAX ? summary.slice(0, CHECKS_SUMMARY_MAX) : summary;
  await octokit.request(
    'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
    {
      owner,
      repo,
      check_run_id: checkRunId,
      status: 'completed',
      completed_at: new Date().toISOString(),
      conclusion,
      output: { title, summary: safe },
    },
  );
}
