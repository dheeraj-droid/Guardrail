// Spec F — Verdict matrix (SRD §4 state machine). PURE (CLAUDE.md Law 2):
// no IO, no env, no Date, no randomness. Same inputs → same output.
import type { BreakingChange, UsageMatch, Verdict } from '@/types/contract';

/**
 * Map (breaking changes, frontend usage matches) → the GitHub Checks verdict.
 *
 * The exact matrix (Spec F / SRD §4):
 *
 *   changes | matches | conclusion | shouldComment
 *   --------|---------|------------|--------------
 *      0    |  any    |  success   |    false
 *     >0    |   0     |  success   |    true
 *     >0    |  >0     |  failure   |    true
 *
 * Note: 0 changes with >0 matches is impossible upstream (matches are only
 * produced for fields that actually changed). If it ever occurs we treat it as
 * the first row — the changes count wins — so Guardrail never blocks a merge
 * without a corresponding schema change.
 */
export function computeVerdict(
  changes: readonly BreakingChange[],
  matches: readonly UsageMatch[],
): Verdict {
  const changeCount = changes.length;
  const matchCount = matches.length;

  // Row 1 — no breaking changes (changes-count wins over any stray matches).
  if (changeCount === 0) {
    return {
      conclusion: 'success',
      title: 'No breaking schema changes found',
      summary:
        'No breaking schema changes were detected in the OpenAPI contract. Nothing to review.',
      shouldComment: false,
    };
  }

  // Row 2 — breaking changes exist but nothing in the frontend references them.
  if (matchCount === 0) {
    return {
      conclusion: 'success',
      title: `${changeCount} schema change(s), no frontend references`,
      summary:
        `Found ${changeCount} breaking schema change(s), but no frontend references to the ` +
        `affected fields were found. Safe to merge.`,
      shouldComment: true,
    };
  }

  // Row 3 — breaking changes AND frontend references → block the merge.
  return {
    conclusion: 'failure',
    title: `${matchCount} broken frontend reference(s) to ${changeCount} schema change(s)`,
    summary:
      `Found ${matchCount} frontend reference(s) to ${changeCount} breaking schema change(s). ` +
      `Merge is blocked until the frontend references are removed or the schema change is reverted.`,
    shouldComment: true,
  };
}
