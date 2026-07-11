// Spec F — PR comment + Checks summary formatting. PURE (CLAUDE.md Law 2):
// no IO, no env, no Date, no randomness. String building only — no markdown lib.
import type { BreakingChange, ScanReport, UsageMatch } from '@/types/contract';

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
  const { changes, scan, frontendRepoFullName, openapiFilePath } = opts;
  const matches = scan.matches;

  const lines: string[] = [];

  lines.push(REPORT_MARKER);
  lines.push('## Guardrail Contract Report');
  lines.push('');
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
