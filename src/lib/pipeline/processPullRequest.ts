// Spec H — The Pipeline Orchestrator (SRD §2). The ONLY module allowed to glue
// gateway -> diff -> db -> scan -> report -> GitHub (CLAUDE.md "Repository map").
// Every external effect is dependency-injected via PipelineDeps so tests can run this
// against fakes (Track J's integration test does the same with real fakes).
//
// Law 10 (fail-open): this function never rejects and never concludes `failure` from an
// error path — `failure` is emitted ONLY by the verdict matrix (report/verdict.ts) row 3.
// Law 15: this is the single place that applies report/formatComment's rich,
// newline-aware `truncateForChecks` before every Checks API call.
import type { Octokit } from 'octokit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';
import type { PipelineInput } from '@/types/github';
import type { ProjectLink } from '@/types/db';
import type { CheckConclusion } from '@/types/contract';

import { getProjectLinkByBackendRepoId } from '@/lib/db/projectLinks';
import { fetchFileText, FileNotFoundError } from '@/lib/github/contents';
import { createInProgressCheckRun, concludeCheckRun } from '@/lib/github/checks';
import { upsertPrComment } from '@/lib/github/comments';
import { parseOpenApiSpec, SpecParseError } from '@/lib/diff/parseSpec';
import { diffOpenApiSchemas } from '@/lib/diff/diffSchemas';
import { scanFrontendRepo } from '@/lib/scan/scanRepo';
import { computeVerdict } from '@/lib/report/verdict';
import { formatPrComment, truncateForChecks } from '@/lib/report/formatComment';

export interface PipelineDeps {
  env: Env;
  db: SupabaseClient;
  getInstallationClient(env: Env, installationId: number): Promise<Octokit>;
}

/** Never rejects: all failure modes are handled internally (Law 10). */
export async function processPullRequest(deps: PipelineDeps, input: PipelineInput): Promise<void> {
  const { backendRepoId, backendOwner, backendRepo, installationId, headSha, baseRef, prNumber } =
    input;

  // Step 1 — resolve the project link. No check run exists yet at this point, so an
  // unexpected lookup failure has nothing to conclude against: log and fail open.
  let link: ProjectLink | null;
  try {
    link = await getProjectLinkByBackendRepoId(deps.db, backendRepoId);
  } catch (error) {
    logCaughtError('project_links lookup failed', error);
    return;
  }

  if (link === null) {
    // Unregistered repos must see zero Guardrail surface — no check run is created.
    console.log(`[guardrail] repo ${backendRepoId} not registered — skipping`);
    return;
  }

  // Steps 2-3 — authenticate as the App installation, then open the check run. Failures
  // here also precede any check run existing, so again there is nothing to conclude.
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

  // From here on, every exit path must conclude checkRunId (steps 4-11, wrapped below).
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
        await conclude(octokit, {
          owner: backendOwner,
          repo: backendRepo,
          checkRunId,
          conclusion: 'neutral',
          title: 'OpenAPI spec not found',
          summary: `No OpenAPI spec was found at \`${link.openapi_file_path}\` on either the base or head ref.`,
        });
        return;
      }

      if (newText !== null) {
        // old missing, new exists -> spec newly ADDED: no old contract to break.
        await conclude(octokit, {
          owner: backendOwner,
          repo: backendRepo,
          checkRunId,
          conclusion: 'success',
          title: 'New OpenAPI spec added',
          summary: `A new OpenAPI spec was added at \`${link.openapi_file_path}\`. There is no previous contract to compare against.`,
        });
        return;
      }

      // old exists, new missing -> spec REMOVED in this PR. v1 rule: do not treat every
      // old field as breaking — ask the team to review the removal manually instead.
      await conclude(octokit, {
        owner: backendOwner,
        repo: backendRepo,
        checkRunId,
        conclusion: 'neutral',
        title: 'OpenAPI spec was removed',
        summary: `The OpenAPI spec at \`${link.openapi_file_path}\` was removed in this PR. Guardrail cannot diff a removed contract — please review the frontend impact manually.`,
      });
      return;
    }

    // Step 5 — parse both specs. A SpecParseError on either fails open as neutral;
    // anything else is an unexpected error and bubbles to the outer catch.
    let oldSpec: Record<string, unknown>;
    let newSpec: Record<string, unknown>;
    try {
      oldSpec = parseOpenApiSpec(oldText, link.openapi_file_path);
      newSpec = parseOpenApiSpec(newText, link.openapi_file_path);
    } catch (error) {
      if (error instanceof SpecParseError) {
        await conclude(octokit, {
          owner: backendOwner,
          repo: backendRepo,
          checkRunId,
          conclusion: 'neutral',
          title: 'OpenAPI spec unparseable',
          summary: `Guardrail could not parse the OpenAPI spec at \`${link.openapi_file_path}\`: ${error.message}`,
        });
        return;
      }
      throw error;
    }

    // Step 6 — diff.
    const changes = diffOpenApiSchemas(oldSpec, newSpec);

    // Step 7 — zero breaking changes: skip ALL frontend work (zero scan API calls).
    if (changes.length === 0) {
      const verdict = computeVerdict([], []);
      await conclude(octokit, {
        owner: backendOwner,
        repo: backendRepo,
        checkRunId,
        conclusion: verdict.conclusion,
        title: verdict.title,
        summary: verdict.summary,
      });
      return;
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
          await conclude(octokit, {
            owner: backendOwner,
            repo: backendRepo,
            checkRunId,
            conclusion: 'neutral',
            title: 'Frontend repository unreachable',
            summary: `Guardrail could not access the linked frontend repository (id ${link.frontend_repo_id}). Ensure the GitHub App installation covers this repository.`,
          });
          return;
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
      concurrency: deps.env.scanConcurrency,
      maxFiles: deps.env.maxScanFiles,
    });

    // Step 10 — verdict + optional PR comment.
    const verdict = computeVerdict(changes, scan.matches);
    if (verdict.shouldComment) {
      await upsertPrComment(octokit, {
        owner: backendOwner,
        repo: backendRepo,
        prNumber,
        body: formatPrComment({
          changes,
          scan,
          frontendRepoFullName: `${frontendOwner}/${frontendRepo}`,
          openapiFilePath: link.openapi_file_path,
        }),
      });
    }

    // Step 11 — conclude the check run.
    await conclude(octokit, {
      owner: backendOwner,
      repo: backendRepo,
      checkRunId,
      conclusion: verdict.conclusion,
      title: verdict.title,
      summary: verdict.summary,
    });
  } catch (error) {
    // CATCH (anything from steps 4-11): fail open. NEVER conclude `failure` here —
    // `failure` is only ever emitted by the verdict matrix (Law 10).
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
