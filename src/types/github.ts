// FROZEN CONTRACT (CLAUDE.md Law 1). Minimal hand-rolled webhook shapes — we intentionally
// do NOT depend on @octokit/webhooks-types (approved-dependency list, CLAUDE.md).

/** The subset of GitHub's pull_request webhook payload Guardrail reads (SRD Module 1). */
export interface PullRequestWebhookPayload {
  action: string; // we act on 'opened' | 'synchronize'
  installation?: { id: number };
  repository: {
    id: number;
    name: string;
    owner: { login: string };
    full_name: string;
  };
  pull_request: {
    number: number;
    head: { sha: string; ref: string };
    base: { ref: string };
  };
}

/** Normalized input handed to the pipeline after the route extracts the payload. */
export interface PipelineInput {
  installationId: number;
  backendRepoId: number;
  backendOwner: string;
  backendRepo: string;
  prNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
}
