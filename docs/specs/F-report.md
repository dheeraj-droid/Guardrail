# Spec F — Verdict Matrix + Report Formatting

**Wave:** 1 | **Agent:** module-builder | **Depends on:** W0
**Files produced:** `src/lib/report/verdict.ts`, `src/lib/report/formatComment.ts`,
`tests/report/verdict.test.ts`, `tests/report/formatComment.test.ts`

Both files are PURE (Law 2). No IO, no env, no Octokit types.

## File 1 — verdict.ts  (SRD §4 state machine — the exact matrix)
```ts
import type { BreakingChange, UsageMatch, Verdict } from '@/types/contract';
export function computeVerdict(
  changes: readonly BreakingChange[],
  matches: readonly UsageMatch[],
): Verdict;
```
The ONLY logic (no other inputs, no config):

| changes | matches | conclusion | title | shouldComment |
|---|---|---|---|---|
| 0 | any | `success` | `No breaking schema changes found` | `false` |
| >0 | 0 | `success` | `` `${changes.length} schema change(s), no frontend references` `` | `true` |
| >0 | >0 | `failure` | `` `${matches.length} broken frontend reference(s) to ${changes.length} schema change(s)` `` | `true` |

- `summary`: one-to-three markdown sentences restating the row (counts included). For the
  failure row, end with `Merge is blocked until the frontend references are removed or the
  schema change is reverted.`
- `matches` with 0 `changes` is impossible upstream; if it occurs, treat as row 1
  (changes-count wins) — add a code comment.
- Pure function: no Date, no randomness → same inputs, same output.

## File 2 — formatComment.ts
```ts
import type { BreakingChange, ScanReport } from '@/types/contract';

export const CHECKS_SUMMARY_LIMIT = 65535;
/** Hard-cap text for the Checks API `output.summary` (Law 15). */
export function truncateForChecks(text: string): string;

export function formatPrComment(opts: {
  changes: readonly BreakingChange[];
  scan: ScanReport;
  frontendRepoFullName: string;   // "owner/name"
  openapiFilePath: string;
}): string;
```

### truncateForChecks rules
- `text.length <= 65535` → return unchanged.
- Else slice to `65535 - 60`, cut at the last `\n` within the slice (avoid mid-table
  breaks), append `\n\n…truncated by Guardrail (output limit).`.
- Result length must be `<= 65535` for ANY input (test with adversarial no-newline input).

### formatPrComment layout (exactly this structure)
```md
<!-- guardrail-report -->
## Guardrail Contract Report

Analyzed `{openapiFilePath}` against frontend `{frontendRepoFullName}`.

### Schema changes ({N})
| Field | Parent | Change | Old type | New type |
|---|---|---|---|---|
| `phoneNumber` | `User` | DELETED | — | — |
| `age` | `User` | TYPE_MUTATED | `integer` | `string` |

### Broken frontend references ({M})        ← section only when M > 0
**`src/components/Profile.tsx`**            ← grouped by file, files sorted asc
- Line 42, col 18 — `phoneNumber` (property-access): `{snippet}`
- Line 7, col 9 — `age` (destructuring): `{snippet}`

_No frontend references found — safe to merge._   ← this line only when M == 0

---
_Scanned {scannedFileCount} file(s)._{truncation-note}
```
- The FIRST line must be the marker `<!-- guardrail-report -->` (comments.ts upserts on it).
- Within a file group, order matches by line asc, then column asc.
- `{truncation-note}`: when `scan.truncated`, append exactly
  ` ⚠️ File list was truncated (MAX_SCAN_FILES or GitHub tree cap) — results may be incomplete.`
- DELETED rows show `—` in both type columns; TYPE_MUTATED shows `original`/`updated`
  in backticks.
- Escape pipe characters in snippets (`|` → `\|`) so the table cannot break.

## Acceptance tests
verdict:
1. `[] , []` → success / shouldComment false / title exact.
2. 2 changes, 0 matches → success / shouldComment true / title contains "2".
3. 1 change, 3 matches → failure / title contains "3" and "1" / summary contains
   "Merge is blocked".
4. Impossible row (0 changes, 2 matches) → row-1 verdict.
formatComment:
5. Marker is the first line.
6. Golden test: fixed changes+matches → assert full table row strings and grouping order
   (file asc, line asc).
7. M == 0 → contains the italics "safe to merge" line and NO "Broken frontend references"
   heading.
8. truncated flag → warning sentence present.
9. truncateForChecks: 100k chars no newlines → length ≤ 65535 and endsWith truncation note;
   short string unchanged.
10. Snippet containing `|` renders escaped (table intact).

## Forbidden
- Reading env, clocks, or anything non-deterministic.
- Any markdown library — string building only.
