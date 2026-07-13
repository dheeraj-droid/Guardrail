// Track E — GitHub Adapters. Checks API transport (SRD §4).
import type { Octokit } from 'octokit';
import type { CheckConclusion } from '@/types/contract';

export const CHECK_NAME = 'Guardrail Contract Check';

// GitHub Checks output.summary hard limit (Law 15). Defensive belt-and-suspenders
// cap only — the rich, newline-aware truncateForChecks (Track F) is applied
// UPSTREAM by the pipeline (Track H). This slice keeps the transport from ever
// 422-ing regardless of caller behaviour.
const CHECKS_SUMMARY_MAX = 65535;

/**
 * Create the run in_progress as soon as processing starts; returns check_run id.
 *
 * Idempotent (Track N, docs/specs/N-retry-queue.md File 5): reuses an existing
 * NOT-YET-COMPLETED run with our name on this exact repo+sha instead of creating a
 * duplicate. A queue retry (or a GitHub redelivery that slipped past the ingress
 * delivery-claim) invoking this a second time for the same commit must not produce a
 * second check run. This is the fix that actually closes the QStash-retry double-run
 * gap — see the Purpose section of the spec above for the full reasoning.
 */
export async function createInProgressCheckRun(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string },
): Promise<number> {
  const { owner, repo, headSha } = params;

  const { data: existing } = await octokit.request(
    'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
    { owner, repo, ref: headSha, check_name: CHECK_NAME },
  );
  // Filter on name explicitly, even though check_name already scopes the GET query —
  // defensive against a mock/fake in tests not honoring the query param, and makes this
  // function's own logic (not just the API call) what's actually being verified.
  const inFlight = existing.check_runs.find(
    (run) => run.status !== 'completed' && run.name === CHECK_NAME,
  );
  if (inFlight) {
    return inFlight.id;
  }

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
