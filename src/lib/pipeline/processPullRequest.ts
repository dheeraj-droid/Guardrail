// Spec H — The Pipeline Orchestrator (SRD §2). The ONLY module allowed to glue
// gateway -> diff -> db -> scan -> report -> GitHub (CLAUDE.md "Repository map").
// Every external effect is dependency-injected via PipelineDeps so tests can run this
// against fakes (Track J's integration test does the same with real fakes).
//
// Law 10 (fail-open): this function never rejects and never concludes `failure` from an
// error path — `failure` is emitted ONLY by the verdict matrix (report/verdict.ts) row 3.
// Law 15: this is the single place that applies report/formatComment's rich,
// newline-aware `truncateForChecks` before every Checks API call.
//
// v2 (Spec P — Wave V2 pipeline integration, docs/PLAN_V2.md §4-§5): a backend repo may
// now have MULTIPLE project_links rows (Track O's plural lookup). Each link is evaluated
// independently into a LinkOutcome (never throws — every failure mode becomes a variant
// instead of an early conclude()/return), then aggregateVerdicts (Track P, pure) combines
// all outcomes into ONE check run and ONE comment per PR. For exactly one link this
// reduces byte-identically to v1's single-link behavior (aggregateVerdicts's and
// formatAggregatePrComment's own degeneracy guarantees) — this file's control flow below
// is the same shape as v1, just parameterized over N links instead of exactly one.
import type { Octokit } from 'octokit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';
import type { PipelineInput } from '@/types/github';
import type { ProjectLink } from '@/types/db';
import type { BreakingChange, CheckConclusion, ScanReport, Verdict } from '@/types/contract';

import { getProjectLinksByBackendRepoId } from '@/lib/db/projectLinks';
import { fetchFileText, FileNotFoundError } from '@/lib/github/contents';
import { createInProgressCheckRun, concludeCheckRun } from '@/lib/github/checks';
import { upsertPrComment } from '@/lib/github/comments';
import { parseOpenApiSpec, SpecParseError } from '@/lib/diff/parseSpec';
import { diffOpenApiSchemas } from '@/lib/diff/diffSchemas';
import { resolveSpecRefs } from '@/lib/github/fetchExternalRefs';
import { scanFrontendRepo } from '@/lib/scan/scanRepo';
import { mapWithConcurrency } from '@/lib/scan/concurrency';
import { computeVerdict } from '@/lib/report/verdict';
import { formatAggregatePrComment, truncateForChecks } from '@/lib/report/formatComment';
import { aggregateVerdicts } from '@/lib/report/aggregateVerdicts';

export interface PipelineDeps {
  env: Env;
  db: SupabaseClient;
  getInstallationClient(env: Env, installationId: number): Promise<Octokit>;
}

/**
 * Reified result of evaluating ONE project_links row against a PR (Spec P). Every
 * variant here corresponds to exactly one of today's (v1) six per-link outcomes:
 * five early-return special cases (`no-spec`, `spec-added`, `spec-removed`,
 * `spec-unparseable`, `frontend-unreachable`) plus the full evaluate-and-conclude path
 * (`evaluated`), plus one NEW kind — `internal-error` — reified per-link so one link's
 * unexpected error can never abort evaluation of the others (Law 10 extended to link
 * granularity, not just pipeline granularity).
 */
export type LinkOutcome =
  | {
      kind: 'evaluated';
      link: ProjectLink;
      frontendRepoFullName: string;
      changes: BreakingChange[];
      scan: ScanReport;
      verdict: Verdict; // computeVerdict(changes, scan.matches) — UNCHANGED function
    }
  | { kind: 'no-spec'; link: ProjectLink }
  | { kind: 'spec-added'; link: ProjectLink }
  | { kind: 'spec-removed'; link: ProjectLink }
  | { kind: 'spec-unparseable'; link: ProjectLink; message: string }
  | { kind: 'frontend-unreachable'; link: ProjectLink }
  | { kind: 'internal-error'; link: ProjectLink; message: string };

/** Never rejects: all failure modes are handled internally (Law 10). */
export async function processPullRequest(deps: PipelineDeps, input: PipelineInput): Promise<void> {
  const { backendRepoId, backendOwner, backendRepo, installationId, headSha, baseRef, prNumber } =
    input;

  // Step 1 — resolve the project links (plural, Track O). No check run exists yet at
  // this point, so an unexpected lookup failure has nothing to conclude against: log
  // and fail open.
  let links: ProjectLink[];
  try {
    links = await getProjectLinksByBackendRepoId(deps.db, backendRepoId);
  } catch (error) {
    logCaughtError('project_links lookup failed', error);
    return;
  }

  if (links.length === 0) {
    // Unregistered repos must see zero Guardrail surface — no check run is created.
    console.log(`[guardrail] repo ${backendRepoId} not registered — skipping`);
    return;
  }

  // Steps 2-3 — authenticate as the App installation, then open ONE check run (shared
  // across every link — Track O's resolved aggregated-verdict decision, PLAN_V2.md §4).
  // Failures here also precede any check run existing, so again there is nothing to
  // conclude.
  let octokit: Octokit;
  let checkRunId: number;
  try {
    octokit = await deps.getInstallationClient(deps.env, installationId);
    checkRunId = await createInProgressCheckRun(octokit, {
      owner: backendOwner,
      repo: backendRepo,
      headSha,
    });
  } catch (error) {
    logCaughtError('failed to start check run', error);
    return;
  }

  // From here on, every exit path must conclude checkRunId.
  try {
    // Step 4 — evaluate every link independently, bounded concurrency (Law 9 applied at
    // link-fan-out granularity). evaluateLink NEVER rejects — every failure mode inside
    // it resolves to a LinkOutcome variant instead — which is what makes this safe under
    // mapWithConcurrency (whose own doc comment says it rejects on the FIRST worker
    // error).
    const outcomes = await mapWithConcurrency(
      links,
      deps.env.maxFrontendLinksConcurrency,
      (link) =>
        evaluateLink(octokit, deps.env, backendOwner, backendRepo, backendRepoId, baseRef, headSha, link),
    );

    // Step 5 — aggregate. For links.length === 1 this reduces to exactly today's
    // single-link conclusion/title/summary (aggregateVerdicts's degeneracy guarantee).
    const verdict = aggregateVerdicts(outcomes);

    // Step 6 — optional PR comment (buildCommentBody === formatAggregatePrComment,
    // which itself calls the existing formatPrComment unchanged for outcomes.length === 1).
    if (verdict.shouldComment) {
      await upsertPrComment(octokit, {
        owner: backendOwner,
        repo: backendRepo,
        prNumber,
        body: formatAggregatePrComment(outcomes),
      });
    }

    // Step 7 — conclude the check run.
    await conclude(octokit, {
      owner: backendOwner,
      repo: backendRepo,
      checkRunId,
      conclusion: verdict.conclusion,
      title: verdict.title,
      summary: verdict.summary,
    });
  } catch (error) {
    // CATCH: fail open. NEVER conclude `failure` here — `failure` is only ever emitted
    // by the verdict matrix (Law 10). This now only fires for a bug in orchestration
    // itself (link resolution, check-run open/conclude, aggregation, comment upsert) —
    // NOT for a single link's own failure, which evaluateLink already absorbs into a
    // LinkOutcome.
    logCaughtError('pipeline error', error);
    try {
      const message = error instanceof Error ? error.message : String(error);
      await conclude(octokit, {
        owner: backendOwner,
        repo: backendRepo,
        checkRunId,
        conclusion: 'neutral',
        title: 'Guardrail internal error',
        summary: `Guardrail hit an unexpected error and did not evaluate this PR. Merges are not blocked. Error: ${message}`,
      });
    } catch (concludeError) {
      // A failing conclude must not crash the process.
      logCaughtError('failed to conclude check run after pipeline error', concludeError);
    }
  }
}

// ---- evaluateLink -------------------------------------------------------------------

/**
 * Evaluate ONE project_links row against the PR. Today's (v1) steps 4-9 verbatim, with
 * exactly one addition (Track L wiring — resolveSpecRefs on both specs before diffing)
 * and one output-shape change (every branch RETURNS a LinkOutcome instead of calling
 * conclude()/upsertPrComment() directly). NEVER rejects — the entire body is wrapped in
 * try/catch; the catch produces `{ kind: 'internal-error', link, message }`.
 */
async function evaluateLink(
  octokit: Octokit,
  env: Env,
  backendOwner: string,
  backendRepo: string,
  backendRepoId: number,
  baseRef: string,
  headSha: string,
  link: ProjectLink,
): Promise<LinkOutcome> {
  try {
    // Step 4 — fetch old + new OpenAPI spec text via the Contents API (Law 11 — the
    // allowed use of Contents; everything else uses Blobs).
    const oldText = await fetchSpecTextOrNull(octokit, {
      owner: backendOwner,
      repo: backendRepo,
      path: link.openapi_file_path,
      ref: baseRef,
    });
    const newText = await fetchSpecTextOrNull(octokit, {
      owner: backendOwner,
      repo: backendRepo,
      path: link.openapi_file_path,
      ref: headSha,
    });

    if (oldText === null || newText === null) {
      if (oldText === null && newText === null) {
        return { kind: 'no-spec', link };
      }

      if (newText !== null) {
        // old missing, new exists -> spec newly ADDED: no old contract to break.
        return { kind: 'spec-added', link };
      }

      // old exists, new missing -> spec REMOVED in this PR. v1 rule: do not treat every
      // old field as breaking — ask the team to review the removal manually instead.
      return { kind: 'spec-removed', link };
    }

    // Step 5 — parse both specs. A SpecParseError on either fails open as neutral;
    // anything else is an unexpected error and bubbles to this function's own catch.
    let oldSpec: Record<string, unknown>;
    let newSpec: Record<string, unknown>;
    try {
      oldSpec = parseOpenApiSpec(oldText, link.openapi_file_path);
      newSpec = parseOpenApiSpec(newText, link.openapi_file_path);
    } catch (error) {
      if (error instanceof SpecParseError) {
        return { kind: 'spec-unparseable', link, message: error.message };
      }
      throw error;
    }

    // Track L wiring — resolve cross-file $refs on both specs before diffing.
    // resolveSpecRefs never throws (Spec L's contract) — no new try/catch needed
    // around these two calls specifically.
    oldSpec = await resolveSpecRefs(octokit, {
      owner: backendOwner,
      repo: backendRepo,
      ref: baseRef,
      rootSpec: oldSpec,
      rootPath: link.openapi_file_path,
      maxDepth: env.maxRefResolutionDepth,
      concurrency: env.scanConcurrency,
    });
    newSpec = await resolveSpecRefs(octokit, {
      owner: backendOwner,
      repo: backendRepo,
      ref: headSha,
      rootSpec: newSpec,
      rootPath: link.openapi_file_path,
      maxDepth: env.maxRefResolutionDepth,
      concurrency: env.scanConcurrency,
    });

    // Step 6 — diff.
    const changes = diffOpenApiSchemas(oldSpec, newSpec);

    // Step 7 — zero breaking changes: skip ALL frontend work (zero scan API calls).
    if (changes.length === 0) {
      return {
        kind: 'evaluated',
        link,
        frontendRepoFullName: frontendLabelForZeroChanges(link, backendOwner, backendRepo, backendRepoId),
        changes: [],
        scan: { matches: [], scannedFileCount: 0, truncated: false },
        verdict: computeVerdict([], []),
      };
    }

    // Step 8 — resolve frontend repo coordinates.
    let frontendOwner: string;
    let frontendRepo: string;
    let scanRef: string;

    if (link.frontend_repo_id === backendRepoId) {
      // MONOREPO (Law 8): scan the PR's OWN head — the frontend code as it would be
      // after merge.
      frontendOwner = backendOwner;
      frontendRepo = backendRepo;
      scanRef = headSha;
    } else {
      // Cross-repo: resolve via the App installation, which must also cover the
      // frontend repo (documented assumption) — scan what is deployed-ish today.
      try {
        const { data: repoData } = await octokit.request('GET /repositories/{id}', {
          id: link.frontend_repo_id,
        });
        frontendOwner = repoData.owner.login;
        frontendRepo = repoData.name;
        scanRef = repoData.default_branch;
      } catch (error) {
        if (isHttpStatus(error, [404, 403])) {
          return { kind: 'frontend-unreachable', link };
        }
        throw error;
      }
    }

    // Step 9 — bounded scan of the frontend repo for the changed fields.
    const targetFields = new Set(changes.map((c) => c.field));
    const scan = await scanFrontendRepo({
      octokit,
      owner: frontendOwner,
      repo: frontendRepo,
      ref: scanRef,
      srcDirectory: link.frontend_src_directory,
      openapiFilePath: link.openapi_file_path,
      targetFields,
      concurrency: env.scanConcurrency,
      maxFiles: env.maxScanFiles,
    });

    const verdict = computeVerdict(changes, scan.matches);

    return {
      kind: 'evaluated',
      link,
      frontendRepoFullName: `${frontendOwner}/${frontendRepo}`,
      changes,
      scan,
      verdict,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'internal-error', link, message };
  }
}

/**
 * Label for the zero-changes evaluated outcome, which (by design, see step 7) never
 * resolves frontend repo coordinates via an API call — matching v1's behavior of
 * skipping ALL frontend work when there are no breaking changes to look for. Monorepo
 * links get the backend repo's own coordinates (no lookup needed); cross-repo links
 * fall back to a numeric-id label rather than inventing a new API call just to name
 * them (mirrors aggregateVerdicts's own non-evaluated-outcome fallback).
 */
function frontendLabelForZeroChanges(
  link: ProjectLink,
  backendOwner: string,
  backendRepo: string,
  backendRepoId: number,
): string {
  if (link.frontend_repo_id === backendRepoId) {
    return `${backendOwner}/${backendRepo}`;
  }
  return `repo ${link.frontend_repo_id}`;
}

// ---- internal helpers --------------------------------------------------------------

/** Fetch spec text; a FileNotFoundError becomes `null`, everything else rethrows. */
async function fetchSpecTextOrNull(
  octokit: Octokit,
  params: { owner: string; repo: string; path: string; ref: string },
): Promise<string | null> {
  try {
    return await fetchFileText(octokit, params);
  } catch (error) {
    if (error instanceof FileNotFoundError) return null;
    throw error;
  }
}

/** True when `error` looks like an Octokit HTTP error with one of `statuses`. */
function isHttpStatus(error: unknown, statuses: readonly number[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number' &&
    statuses.includes((error as { status: number }).status)
  );
}

/**
 * Conclude the check run. Logs the conclusion+title (logging rule) and truncates the
 * summary (Law 15 — the pipeline is the single place that applies the rich,
 * newline-aware truncateForChecks before every Checks API call; checks.ts keeps only a
 * defensive hard slice).
 */
async function conclude(
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
  console.log(`[guardrail] concluding check run: ${params.conclusion} — ${params.title}`);
  await concludeCheckRun(octokit, { ...params, summary: truncateForChecks(params.summary) });
}

/**
 * Log a caught error with the required prefix, message, and stack (logging rule).
 * Never logs env values, spec contents, or tokens — only the error's own message/stack.
 */
function logCaughtError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[guardrail] ${context}: ${message}`);
  if (error instanceof Error && error.stack) {
    console.error(`[guardrail] stack: ${error.stack}`);
  }
}
