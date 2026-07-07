// Spec B, File 3 — diff two flattened OpenAPI specs into BreakingChange[].
// PURE (Law 2): no IO, no env, no logging.

import type { BreakingChange } from '@/types/contract';
import { flattenOpenApiFields } from './flattenSchema';

/**
 * Compare old vs new OpenAPI specs and emit breaking changes
 * (DELETED fields + TYPE_MUTATED fields). Additions are non-breaking and ignored.
 */
export function diffOpenApiSchemas(
  oldSpec: Record<string, unknown>,
  newSpec: Record<string, unknown>,
): BreakingChange[] {
  const oldMap = flattenOpenApiFields(oldSpec);
  const newMap = flattenOpenApiFields(newSpec);

  const changes: BreakingChange[] = [];

  for (const [key, oldRec] of oldMap) {
    const newRec = newMap.get(key);

    if (newRec === undefined) {
      // Absent in new map → DELETED. No original/updated keys at all.
      changes.push({
        field: oldRec.field,
        parent: oldRec.parent,
        change: 'DELETED',
      });
    } else if (newRec.type !== oldRec.type) {
      // Present but type differs → TYPE_MUTATED.
      changes.push({
        field: oldRec.field,
        parent: oldRec.parent,
        change: 'TYPE_MUTATED',
        original: oldRec.type,
        updated: newRec.type,
      });
    }
  }

  // Sort deterministically: by parent asc, then field asc (plain < compare).
  changes.sort((a, b) => {
    if (a.parent < b.parent) return -1;
    if (a.parent > b.parent) return 1;
    if (a.field < b.field) return -1;
    if (a.field > b.field) return 1;
    return 0;
  });

  return changes;
}
