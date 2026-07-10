# Spec M — Renamed-Field Detection

**Wave:** V1 | **Agent:** module-builder | **Depends on:** V0
**Files produced:** `src/lib/diff/detectRenames.ts` (new),
`src/lib/diff/diffSchemas.ts` (edit), `src/lib/report/formatComment.ts` (edit),
`tests/diff/detectRenames.test.ts` (new), `tests/diff/diffSchemas.test.ts` (edit —
new cases only), `tests/report/formatComment.test.ts` (edit — new cases only)

## Purpose

A rename already surfaces correctly today as `DELETED` (frontend code referencing the
old name genuinely breaks — that conclusion does not change). What's missing is the
*hint*: nothing tells the PR author "this looks like a rename, update references to
`newName`" instead of a bare "field deleted." This track adds that hint, and only that
hint — `verdict.ts`'s conclusion logic is untouched.

## File 1 — `src/lib/diff/detectRenames.ts` (PURE — Law 2)

```ts
import type { BreakingChange } from '@/types/contract';
import type { FieldRecord } from './flattenSchema';

/**
 * Post-process a raw changes list: for every DELETED change, look for exactly one
 * unambiguous same-parent, same-type field that is new in `newMap` (present in newMap,
 * absent from oldMap) and set BreakingChange.renamedTo on it. Returns a NEW array
 * (does not mutate `changes`) — same length, same order, only `renamedTo` added/absent
 * per element. TYPE_MUTATED changes are never annotated (a rename candidate requires an
 * exact type match, which a TYPE_MUTATED entry by definition does not have for its OWN
 * field — but see step 3 for why it still needs to be excluded from the CANDIDATE pool).
 */
export function annotateRenames(
  changes: readonly BreakingChange[],
  oldMap: ReadonlyMap<string, FieldRecord>,
  newMap: ReadonlyMap<string, FieldRecord>,
): BreakingChange[];
```

Algorithm (exact — this is the whole spec of this file):
1. Build the candidate-addition pool: every key in `newMap` whose key is NOT in
   `oldMap` (i.e. `[...newMap.keys()].filter(k => !oldMap.has(k))`). Each candidate
   carries its `parent` and `type` (from its `FieldRecord`).
2. Track a `claimed: Set<string>` of candidate keys already assigned to a rename, so
   the same added field can't be offered as the rename target for two different
   deletions.
3. For each `change` in `changes` where `change.change === 'DELETED'`: look up
   `oldMap.get(change.parent + '.' + change.field)` for its `type`. Filter the
   candidate pool to entries where `candidate.parent === change.parent` AND
   `candidate.type === thatType` AND the candidate key is not in `claimed`.
4. Exactly one match → set `renamedTo` to that candidate's `field` name, add its key to
   `claimed`, and move to the next `change`. Zero matches or two-or-more matches →
   leave `renamedTo` unset (ambiguity is not guessed at — a wrong hint is worse than no
   hint). Process deletions in the array's existing order so `claimed` behaves
   deterministically when multiple deletions could otherwise compete for one candidate
   (first-in-order deletion wins the unambiguous match; a later deletion that would have
   matched the same now-claimed candidate falls back to "no match" for that field,
   independently re-evaluated — do not treat this as itself ambiguous, since from that
   later deletion's own perspective, once the shared candidate is removed from the pool,
   whatever remains determines ambiguous/unambiguous/none exactly per the same rule).
5. `TYPE_MUTATED` changes are passed through unchanged (never annotated) — only
   `DELETED` changes are rename candidates, since a `TYPE_MUTATED` field still exists
   under its old name (nothing was renamed).

## File 2 — `src/lib/diff/diffSchemas.ts` (edit)

One addition to `diffOpenApiSchemas`: after computing `changes` from the existing
old/new-map comparison loop, and BEFORE the existing sort, call `annotateRenames(changes,
oldMap, newMap)` and sort *that* result instead of the raw `changes` array. No other line
in this file changes. The exported function's signature
(`(oldSpec, newSpec) => BreakingChange[]`) does not change — callers (including the
existing pipeline) need zero awareness that this ran.

## File 3 — `src/lib/report/formatComment.ts` (edit)

In `schemaChangeRow`, when `change.change === 'DELETED'` and `change.renamedTo` is set,
append a rename hint to the row instead of leaving it as a bare deletion. Keep the
existing table shape (5 columns: Field, Parent, Change, Old type, New type) — do not add
a column (that would be a wider blast-radius change than this hint warrants, and would
touch every existing row-rendering test). Render the hint inside the `Change` cell:

```
DELETED (looks renamed to `ageYears`)
```

i.e. `change.change === 'DELETED' && change.renamedTo ? \`DELETED (looks renamed to
\\\`${change.renamedTo}\\\`)\` : change.change`. This is the only line that changes in
`schemaChangeRow`. `verdict.ts` and every other row/section in `formatComment.ts` are
untouched — the hint is cosmetic, never affects `conclusion`/`shouldComment`.

## Acceptance tests

`detectRenames.test.ts` (pure, build `oldMap`/`newMap` directly as
`Map<string, FieldRecord>` literals — no need to go through `flattenOpenApiFields` for
these unit tests):
1. Unambiguous rename: `User.age` deleted (type `integer`), `User.ageYears` added (type
   `integer`), no other candidates in `User` → `renamedTo: 'ageYears'` on the `age`
   change.
2. Ambiguous rename: `User.age` deleted (`integer`), BOTH `User.ageYears` and
   `User.yearsOld` added as `integer` → no `renamedTo` on `age`.
3. Type mismatch: `User.age` deleted (`integer`), `User.ageLabel` added as `string` →
   no `renamedTo` (types must match exactly).
4. Different parent: `User.age` deleted, `Account.age` added (same field name, same
   type, different parent) → no `renamedTo` (parent must match).
5. Two deletions, one shared unambiguous-looking candidate: `User.age` and
   `Account.age` both deleted (different parents, so this doesn't collide with case 4 —
   use e.g. `User.age` and `User.oldAge` both deleted as `integer`, with only
   `User.ageYears` added as `integer`) → whichever deletion is earlier in `changes`'s
   input order claims `ageYears`; the later one gets no `renamedTo` (not "ambiguous" —
   simply no candidate left, per algorithm step 4's `claimed` set).
6. `TYPE_MUTATED` change passed through with no `renamedTo` field at all (not even
   `undefined` explicitly set — the property should be absent, matching how the rest of
   `BreakingChange` already treats optional fields).

`diffSchemas.test.ts` — one new case: two specs where a field is deleted from one name
and an identically-typed field is added under a new name in the same parent →
`diffOpenApiSchemas` output includes the `DELETED` entry with `renamedTo` set (proves the
wiring, not the algorithm — the algorithm's exhaustive cases live in
`detectRenames.test.ts`).

`formatComment.test.ts` — one new case: a `DELETED` change with `renamedTo` set renders
`` DELETED (looks renamed to `ageYears`) `` in the Change column; an existing `DELETED`
change WITHOUT `renamedTo` still renders exactly `DELETED` (regression check — the
existing test asserting today's plain-DELETED row must still pass unmodified).

## Forbidden

- Any change to `verdict.ts` or to `computeVerdict`'s conclusion/shouldComment logic —
  renames are strictly a messaging enhancement.
- Adding a table column to `formatPrComment`'s schema-changes table.
- Guessing a rename across a type change, or across a parent change, under any
  heuristic relaxation — the exact-match-only rule is the whole point (a wrong guess
  actively misleads the PR author).
- Touching `flattenSchema.ts` — `FieldRecord`'s shape is consumed, not modified.
