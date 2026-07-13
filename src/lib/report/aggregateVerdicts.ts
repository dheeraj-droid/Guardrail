// Spec P, File 2 — combine N per-link outcomes into ONE check-run verdict
// (docs/PLAN_V2.md §4). PURE (CLAUDE.md Law 2): no IO, no env, no Date, no randomness.
import type { CheckConclusion, Verdict } from '@/types/contract';
import type { LinkOutcome } from '@/lib/pipeline/processPullRequest';

/** Worst-wins conclusion priority: failure > neutral > success. */
const CONCLUSION_RANK: Record<CheckConclusion, number> = {
  failure: 2,
  neutral: 1,
  success: 0,
};

interface Described {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  shouldComment: boolean;
}

/**
 * Per-outcome mapper producing EXACTLY today's (v1) text for each non-`evaluated` kind
 * — copied character-for-character from `processPullRequest.ts`'s inline early-return
 * branches — and, for `evaluated`, `outcome.verdict` directly (already exactly
 * `computeVerdict`'s output). `shouldComment` is `false` for every non-`evaluated` kind
 * (matches today — none of the five early-return branches ever call `upsertPrComment`).
 */
function describe(outcome: LinkOutcome): Described {
  switch (outcome.kind) {
    case 'evaluated':
      return {
        conclusion: outcome.verdict.conclusion,
        title: outcome.verdict.title,
        summary: outcome.verdict.summary,
        shouldComment: outcome.verdict.shouldComment,
      };

    case 'no-spec':
      return {
        conclusion: 'neutral',
        title: 'OpenAPI spec not found',
        summary: `No OpenAPI spec was found at \`${outcome.link.openapi_file_path}\` on either the base or head ref.`,
        shouldComment: false,
      };

    case 'spec-added':
      return {
        conclusion: 'success',
        title: 'New OpenAPI spec added',
        summary: `A new OpenAPI spec was added at \`${outcome.link.openapi_file_path}\`. There is no previous contract to compare against.`,
        shouldComment: false,
      };

    case 'spec-removed':
      return {
        conclusion: 'neutral',
        title: 'OpenAPI spec was removed',
        summary: `The OpenAPI spec at \`${outcome.link.openapi_file_path}\` was removed in this PR. Guardrail cannot diff a removed contract — please review the frontend impact manually.`,
        shouldComment: false,
      };

    case 'spec-unparseable':
      return {
        conclusion: 'neutral',
        title: 'OpenAPI spec unparseable',
        summary: `Guardrail could not parse the OpenAPI spec at \`${outcome.link.openapi_file_path}\`: ${outcome.message}`,
        shouldComment: false,
      };

    case 'frontend-unreachable':
      return {
        conclusion: 'neutral',
        title: 'Frontend repository unreachable',
        summary: `Guardrail could not access the linked frontend repository (id ${outcome.link.frontend_repo_id}). Ensure the GitHub App installation covers this repository.`,
        shouldComment: false,
      };

    case 'internal-error':
      return {
        conclusion: 'neutral',
        title: 'Guardrail internal error',
        summary: `Guardrail hit an unexpected error and did not evaluate this PR. Merges are not blocked. Error: ${outcome.message}`,
        shouldComment: false,
      };
  }
}

/**
 * Frontend label used in the aggregate summary. Frontend owner/name is only resolved on
 * the `evaluated` path today — the other branches never look it up, so this never
 * invents a new API call just to label them; it falls back to the numeric id (or
 * `(monorepo)` when the link's frontend repo IS the backend repo).
 */
function frontendLabel(outcome: LinkOutcome): string {
  if (outcome.link.frontend_repo_id === outcome.link.backend_repo_id) {
    return '(monorepo)';
  }
  if (outcome.kind === 'evaluated') {
    return outcome.frontendRepoFullName;
  }
  return `repo ${outcome.link.frontend_repo_id}`;
}

/**
 * Combine N per-link outcomes into ONE check-run verdict (docs/PLAN_V2.md §4).
 * DEGENERACY REQUIREMENT: outcomes.length === 1 MUST return exactly the same
 * {conclusion, title, summary, shouldComment} today's single-link
 * processPullRequest.ts would have produced for that one outcome — byte-identical
 * strings, not just equivalent conclusions. This is what makes the single-link path
 * a regression-safe subset of the multi-link path rather than a separate code path.
 */
export function aggregateVerdicts(outcomes: readonly LinkOutcome[]): Verdict {
  if (outcomes.length === 1) {
    return describe(outcomes[0]!);
  }

  const described = outcomes.map(describe);

  let conclusion: CheckConclusion = 'success';
  for (const d of described) {
    if (CONCLUSION_RANK[d.conclusion] > CONCLUSION_RANK[conclusion]) {
      conclusion = d.conclusion;
    }
  }

  const shouldComment = described.some((d) => d.shouldComment);

  const title =
    `${outcomes.length} linked frontend(s) — ` +
    (conclusion === 'failure'
      ? 'breaking references found'
      : conclusion === 'neutral'
        ? 'some frontends could not be evaluated'
        : 'no breaking changes');

  const summary = outcomes
    .map((outcome, i) => `### ${frontendLabel(outcome)}\n${described[i]!.title}\n\n${described[i]!.summary}\n\n`)
    .join('');

  return { conclusion, title, summary, shouldComment };
}
