// Spec F — PR comment + Checks summary formatting. PURE (CLAUDE.md Law 2):
// no IO, no env, no Date, no randomness. String building only — no markdown lib.
//
// Spec P (Wave V2, docs/PLAN_V2.md §4-§5) adds `formatAggregatePrComment`, built on top
// of a `buildSection` helper extracted from `formatPrComment`'s own body (behavior
// preserving — `formatPrComment` still produces byte-identical output).
import type { BreakingChange, ScanReport, UsageMatch } from '@/types/contract';
import type { LinkOutcome } from '@/lib/pipeline/processPullRequest';

/** GitHub Checks API `output.summary` hard limit (CLAUDE.md Law 15). */
export const CHECKS_SUMMARY_LIMIT = 65535;

/** Marker on the first line; comments.ts upserts the PR comment by matching it. */
const REPORT_MARKER = '<!-- guardrail-report -->';

/** Appended by truncateForChecks; kept short so the reserve (60) always covers it. */
const TRUNCATION_NOTE = '\n\n…truncated by Guardrail (output limit).';

/** Footer note appended when the frontend file listing was truncated. */
const TRUNCATION_WARNING =
  ' ⚠️ File list was truncated (MAX_SCAN_FILES or GitHub tree cap) — results may be incomplete.';

/**
 * Hard-cap text for the Checks API `output.summary` (Law 15).
 *
 * - `text.length <= CHECKS_SUMMARY_LIMIT` → returned unchanged.
 * - Otherwise slice to `CHECKS_SUMMARY_LIMIT - 60`, cut back to the last newline
 *   inside that slice (so we never break in the middle of a markdown table row),
 *   then append the truncation note. If the slice contains no newline the full
 *   slice is kept. The result is `<= CHECKS_SUMMARY_LIMIT` for ANY input.
 */
export function truncateForChecks(text: string): string {
  if (text.length <= CHECKS_SUMMARY_LIMIT) return text;

  const slice = text.slice(0, CHECKS_SUMMARY_LIMIT - 60);
  const lastNewline = slice.lastIndexOf('\n');
  const body = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
  return body + TRUNCATION_NOTE;
}

/** Escape pipe characters so a snippet cannot break the markdown table. */
function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** One markdown table row for a schema change; DELETED shows `—` in both type cols. */
function schemaChangeRow(change: BreakingChange): string {
  const oldType = change.change === 'TYPE_MUTATED' ? `\`${change.original ?? ''}\`` : '—';
  const newType = change.change === 'TYPE_MUTATED' ? `\`${change.updated ?? ''}\`` : '—';
  const changeLabel =
    change.change === 'DELETED' && change.renamedTo
      ? `DELETED (looks renamed to \`${change.renamedTo}\`)`
      : change.change;
  return `| \`${change.field}\` | \`${change.parent}\` | ${changeLabel} | ${oldType} | ${newType} |`;
}

/** One bullet line for a broken frontend reference within its file group. */
function usageLine(match: UsageMatch): string {
  // Snippet is wrapped in backticks (spec layout) and pipe-escaped (Spec F rule).
  const snippet = `\`${escapePipes(match.snippet)}\``;
  return `- Line ${match.line}, col ${match.column} — \`${match.field}\` (${match.kind}): ${snippet}`;
}

/**
 * Body shared by `formatPrComment` and the per-link detail sections of
 * `formatAggregatePrComment` (Spec P) — everything between the header and the footer:
 * the "Analyzed X against frontend Y" line, the schema-changes table, and the
 * broken-frontend-references section (or the "safe to merge" line when there are no
 * matches). Extracted verbatim from `formatPrComment`'s own body — no behavior change.
 */
function buildSection(opts: {
  changes: readonly BreakingChange[];
  scan: ScanReport;
  frontendRepoFullName: string; // "owner/name"
  openapiFilePath: string;
}): string[] {
  const { changes, scan, frontendRepoFullName, openapiFilePath } = opts;
  const matches = scan.matches;

  const lines: string[] = [];

  lines.push(`Analyzed \`${openapiFilePath}\` against frontend \`${frontendRepoFullName}\`.`);
  lines.push('');

  // Schema changes table.
  lines.push(`### Schema changes (${changes.length})`);
  lines.push('| Field | Parent | Change | Old type | New type |');
  lines.push('|---|---|---|---|---|');
  for (const change of changes) {
    lines.push(schemaChangeRow(change));
  }
  lines.push('');

  // Broken frontend references — section only when there is at least one match.
  if (matches.length > 0) {
    lines.push(`### Broken frontend references (${matches.length})`);

    for (const filePath of groupFilePathsSorted(matches)) {
      lines.push(`**\`${filePath}\`**`);
      const inFile = matches
        .filter((m) => m.filePath === filePath)
        .slice()
        .sort((a, b) => a.line - b.line || a.column - b.column);
      for (const match of inFile) {
        lines.push(usageLine(match));
      }
      lines.push('');
    }
  } else {
    lines.push('_No frontend references found — safe to merge._');
    lines.push('');
  }

  return lines;
}

/**
 * Build the full PR comment markdown (Spec F layout). The first line is always
 * the report marker. Broken-reference bullets are grouped by file (files sorted
 * ascending) and, within a file, ordered by line then column ascending.
 */
export function formatPrComment(opts: {
  changes: readonly BreakingChange[];
  scan: ScanReport;
  frontendRepoFullName: string; // "owner/name"
  openapiFilePath: string;
}): string {
  const { scan } = opts;

  const lines: string[] = [];

  lines.push(REPORT_MARKER);
  lines.push('## Guardrail Contract Report');
  lines.push('');
  lines.push(...buildSection(opts));

  // Footer.
  lines.push('---');
  const truncationNote = scan.truncated ? TRUNCATION_WARNING : '';
  lines.push(`_Scanned ${scan.scannedFileCount} file(s)._${truncationNote}`);

  return lines.join('\n');
}

/** Distinct file paths of the matches, sorted ascending (stable, deterministic). */
function groupFilePathsSorted(matches: readonly UsageMatch[]): string[] {
  const seen = new Set<string>();
  for (const match of matches) {
    seen.add(match.filePath);
  }
  return Array.from(seen).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---- Spec P — multi-link aggregate comment ------------------------------------------

/** Label for one outcome's row/heading in the aggregate comment (Spec P). */
function frontendLabel(outcome: LinkOutcome): string {
  if (outcome.kind === 'evaluated') return outcome.frontendRepoFullName;
  if (outcome.link.frontend_repo_id === outcome.link.backend_repo_id) return '(monorepo)';
  return `repo ${outcome.link.frontend_repo_id}`;
}

/** `{ icon, status }` for one outcome's row in the multi-link summary table. */
function statusFor(outcome: LinkOutcome): { icon: string; status: string } {
  switch (outcome.kind) {
    case 'evaluated':
      if (outcome.verdict.conclusion === 'failure') return { icon: '❌', status: outcome.verdict.title };
      return { icon: '✅', status: outcome.verdict.title };
    case 'no-spec':
      return { icon: '⚠️', status: 'OpenAPI spec not found' };
    case 'spec-added':
      return { icon: '✅', status: 'New OpenAPI spec added' };
    case 'spec-removed':
      return { icon: '⚠️', status: 'OpenAPI spec was removed' };
    case 'spec-unparseable':
      return { icon: '⚠️', status: 'OpenAPI spec unparseable' };
    case 'frontend-unreachable':
      return { icon: '⚠️', status: 'Frontend repository unreachable' };
    case 'internal-error':
      return { icon: '⚠️', status: 'Guardrail internal error' };
  }
}

/**
 * Multi-link comment composer (Spec P, docs/PLAN_V2.md §4). `outcomes.length === 1`
 * reduces to `formatPrComment` unchanged (byte-identical — the single-link regression
 * safety net). For N > 1, one shared marker/header/footer wraps a summary table (one
 * row per outcome, all outcomes) plus a detail section (via `buildSection`) for every
 * `evaluated` outcome whose own `verdict.shouldComment` is true.
 */
export function formatAggregatePrComment(outcomes: readonly LinkOutcome[]): string {
  if (outcomes.length === 1 && outcomes[0]!.kind === 'evaluated') {
    const only = outcomes[0]! as Extract<LinkOutcome, { kind: 'evaluated' }>;
    return formatPrComment({
      changes: only.changes,
      scan: only.scan,
      frontendRepoFullName: only.frontendRepoFullName,
      openapiFilePath: only.link.openapi_file_path,
    });
  }

  const lines: string[] = [];

  lines.push(REPORT_MARKER);
  lines.push('## Guardrail Contract Report');
  lines.push('');
  lines.push(`${outcomes.length} linked frontend(s) analyzed for this PR.`);
  lines.push('');
  lines.push('| Frontend | Status |');
  lines.push('|---|---|');
  for (const outcome of outcomes) {
    const { icon, status } = statusFor(outcome);
    lines.push(`| \`${frontendLabel(outcome)}\` | ${icon} ${status} |`);
  }
  lines.push('');

  let scannedFileCount = 0;
  let anyTruncated = false;

  for (const outcome of outcomes) {
    if (outcome.kind !== 'evaluated') continue;
    scannedFileCount += outcome.scan.scannedFileCount;
    if (outcome.scan.truncated) anyTruncated = true;

    if (!outcome.verdict.shouldComment) continue;

    lines.push(`### ${frontendLabel(outcome)}`);
    lines.push(
      ...buildSection({
        changes: outcome.changes,
        scan: outcome.scan,
        frontendRepoFullName: outcome.frontendRepoFullName,
        openapiFilePath: outcome.link.openapi_file_path,
      }),
    );
  }

  // Footer.
  lines.push('---');
  const truncationNote = anyTruncated ? TRUNCATION_WARNING : '';
  lines.push(`_Scanned ${scannedFileCount} file(s)._${truncationNote}`);

  return lines.join('\n');
}
