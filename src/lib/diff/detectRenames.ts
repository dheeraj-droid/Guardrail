// Spec M, File 1 — post-process a raw BreakingChange[] to annotate unambiguous
// same-parent, same-type renames onto DELETED entries. PURE (Law 2): no IO.

import type { BreakingChange } from '@/types/contract';
import type { FieldRecord } from './flattenSchema';

/** Split a camelCase/PascalCase identifier into lowercase words, e.g. "phoneNumber" -> ["phone","number"]. */
function camelWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Cheap, conservative signal that two field names might name the same underlying
 * concept: one name (case-insensitively) contains the other, or they share at least
 * one camelCase "word." Exists to stop the rename heuristic from firing on
 * coincidentally same-parent, same-type but semantically unrelated fields (e.g.
 * `phoneNumber` deleted + `middleName` added, both `string`, same parent — a real
 * fixture case that produced a misleading "looks renamed to middleName" hint before
 * this check existed). `age` -> `ageYears` still matches (shared word "age");
 * `phoneNumber` -> `middleName` does not (no shared word, no substring relation).
 */
function namesLikelyRelated(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA.includes(lowerB) || lowerB.includes(lowerA)) return true;
  const wordsA = new Set(camelWords(a));
  return camelWords(b).some((word) => wordsA.has(word));
}

/**
 * Post-process a raw changes list: for every DELETED change, look for exactly one
 * unambiguous same-parent, same-type, name-related field that is new in `newMap`
 * (present in newMap, absent from oldMap) and set BreakingChange.renamedTo on it.
 * Returns a NEW array (does not mutate `changes`) — same length, same order, only
 * `renamedTo` added/absent per element. TYPE_MUTATED changes are never annotated (a
 * rename candidate requires an exact type match, which a TYPE_MUTATED entry by
 * definition does not have for its OWN field — but see step 3 for why it still needs
 * to be excluded from the CANDIDATE pool).
 */
export function annotateRenames(
  changes: readonly BreakingChange[],
  oldMap: ReadonlyMap<string, FieldRecord>,
  newMap: ReadonlyMap<string, FieldRecord>,
): BreakingChange[] {
  // 1. Build the candidate-addition pool: entries present in newMap but not oldMap.
  const candidates: Array<{ key: string; record: FieldRecord }> = [];
  for (const [key, record] of newMap) {
    if (!oldMap.has(key)) {
      candidates.push({ key, record });
    }
  }

  // 2. Track claimed candidate keys so no candidate is offered to two deletions.
  const claimed = new Set<string>();

  return changes.map((change) => {
    if (change.change !== 'DELETED') {
      return change;
    }

    const oldKey = change.parent + '.' + change.field;
    const oldRec = oldMap.get(oldKey);
    if (oldRec === undefined) {
      return change;
    }

    // 3. Filter candidates: same parent, same type, name-related, not already claimed.
    const matches = candidates.filter(
      (candidate) =>
        !claimed.has(candidate.key) &&
        candidate.record.parent === change.parent &&
        candidate.record.type === oldRec.type &&
        namesLikelyRelated(change.field, candidate.record.field),
    );

    // 4. Exactly one match → claim it and annotate. Otherwise leave unset.
    if (matches.length === 1) {
      const match = matches[0];
      if (match === undefined) return change;
      claimed.add(match.key);
      return { ...change, renamedTo: match.record.field };
    }

    return change;
  });
}
