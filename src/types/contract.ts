// FROZEN CONTRACT (CLAUDE.md Law 1). Do not edit, extend, or redefine these shapes.
// Every track imports from here; changing a field breaks parallel work.
// FROZEN CONTRACT except for this one additive v2 field (see docs/PLAN_V2.md §7).

/** How a schema field changed between the base and head OpenAPI specs. */
export type ChangeKind = 'DELETED' | 'TYPE_MUTATED';

/** A single breaking change discovered by the contract diff (SRD Module 2). */
export interface BreakingChange {
  field: string; // "phoneNumber"
  parent: string; // "User" | "User.address" | "POST /users request"
  change: ChangeKind;
  original?: string; // TYPE_MUTATED only, e.g. "integer"
  updated?: string; // TYPE_MUTATED only, e.g. "string"
  renamedTo?: string; // set only by diff/detectRenames.ts on an unambiguous same-type
                       // rename match (Track M) — never set anywhere else
}

/** A frontend source location that references a broken field (SRD Module 4). */
export interface UsageMatch {
  field: string;
  filePath: string; // repo-relative, forward slashes
  line: number; // 1-based
  column: number; // 1-based
  kind: 'property-access' | 'destructuring';
  snippet: string; // trimmed source line, max 200 chars
}

/** GitHub Checks conclusion values Guardrail may emit (SRD §4 + fail-open). */
export type CheckConclusion = 'success' | 'failure' | 'neutral';

/** The decision produced by the verdict matrix (SRD §4). */
export interface Verdict {
  conclusion: CheckConclusion;
  title: string; // <= 120 chars
  summary: string; // markdown; caller truncates via truncateForChecks
  shouldComment: boolean;
}

/** Aggregate result of scanning the frontend repository. */
export interface ScanReport {
  matches: UsageMatch[];
  scannedFileCount: number;
  truncated: boolean; // tree truncated OR MAX_SCAN_FILES cap hit
}
