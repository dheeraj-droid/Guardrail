import { describe, it, expect } from 'vitest';
import { annotateRenames } from '@/lib/diff/detectRenames';
import type { FieldRecord } from '@/lib/diff/flattenSchema';
import type { BreakingChange } from '@/types/contract';

describe('annotateRenames', () => {
  it('1. unambiguous rename: sets renamedTo on the DELETED change', () => {
    const oldMap = new Map<string, FieldRecord>([
      ['User.age', { parent: 'User', field: 'age', type: 'integer' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['User.ageYears', { parent: 'User', field: 'ageYears', type: 'integer' }],
    ]);
    const changes: BreakingChange[] = [{ field: 'age', parent: 'User', change: 'DELETED' }];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([
      { field: 'age', parent: 'User', change: 'DELETED', renamedTo: 'ageYears' },
    ]);
    // Original array not mutated.
    expect(changes).toEqual([{ field: 'age', parent: 'User', change: 'DELETED' }]);
  });

  it('2. ambiguous rename: two same-typed, name-related candidates → no renamedTo', () => {
    // Both candidates share the "age" word with the deleted field, so the
    // name-relation gate alone doesn't resolve the ambiguity — genuinely two
    // plausible rename targets, so no guess is made (see also test 7 below, which
    // confirms a candidate that does NOT relate by name is excluded before ambiguity
    // is even considered).
    const oldMap = new Map<string, FieldRecord>([
      ['User.age', { parent: 'User', field: 'age', type: 'integer' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['User.ageYears', { parent: 'User', field: 'ageYears', type: 'integer' }],
      ['User.ageInYears', { parent: 'User', field: 'ageInYears', type: 'integer' }],
    ]);
    const changes: BreakingChange[] = [{ field: 'age', parent: 'User', change: 'DELETED' }];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([{ field: 'age', parent: 'User', change: 'DELETED' }]);
    expect('renamedTo' in result[0]!).toBe(false);
  });

  it('3. type mismatch: candidate with a different type is not offered', () => {
    const oldMap = new Map<string, FieldRecord>([
      ['User.age', { parent: 'User', field: 'age', type: 'integer' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['User.ageLabel', { parent: 'User', field: 'ageLabel', type: 'string' }],
    ]);
    const changes: BreakingChange[] = [{ field: 'age', parent: 'User', change: 'DELETED' }];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([{ field: 'age', parent: 'User', change: 'DELETED' }]);
    expect('renamedTo' in result[0]!).toBe(false);
  });

  it('4. different parent: same field/type but different parent → no renamedTo', () => {
    const oldMap = new Map<string, FieldRecord>([
      ['User.age', { parent: 'User', field: 'age', type: 'integer' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['Account.age', { parent: 'Account', field: 'age', type: 'integer' }],
    ]);
    const changes: BreakingChange[] = [{ field: 'age', parent: 'User', change: 'DELETED' }];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([{ field: 'age', parent: 'User', change: 'DELETED' }]);
    expect('renamedTo' in result[0]!).toBe(false);
  });

  it('5. two deletions sharing one unambiguous candidate: first in order claims it', () => {
    const oldMap = new Map<string, FieldRecord>([
      ['User.age', { parent: 'User', field: 'age', type: 'integer' }],
      ['User.oldAge', { parent: 'User', field: 'oldAge', type: 'integer' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['User.ageYears', { parent: 'User', field: 'ageYears', type: 'integer' }],
    ]);
    const changes: BreakingChange[] = [
      { field: 'age', parent: 'User', change: 'DELETED' },
      { field: 'oldAge', parent: 'User', change: 'DELETED' },
    ];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([
      { field: 'age', parent: 'User', change: 'DELETED', renamedTo: 'ageYears' },
      { field: 'oldAge', parent: 'User', change: 'DELETED' },
    ]);
    expect('renamedTo' in result[1]!).toBe(false);
  });

  it('7. name-unrelated candidate: same parent/type but no name relation → no renamedTo', () => {
    // Regression case for a real false-positive caught in tests/diff/diffSchemas.test.ts's
    // shared fixture: an unrelated field happens to share a parent and type with a
    // deletion. Without a name-relation gate, this was the ONLY same-type candidate,
    // so the old algorithm called it "unambiguous" and wrongly annotated it.
    const oldMap = new Map<string, FieldRecord>([
      ['User.phoneNumber', { parent: 'User', field: 'phoneNumber', type: 'string' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['User.middleName', { parent: 'User', field: 'middleName', type: 'string' }],
    ]);
    const changes: BreakingChange[] = [
      { field: 'phoneNumber', parent: 'User', change: 'DELETED' },
    ];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([{ field: 'phoneNumber', parent: 'User', change: 'DELETED' }]);
    expect('renamedTo' in result[0]!).toBe(false);
  });

  it('8. name-related via substring containment (not just shared camelCase word)', () => {
    const oldMap = new Map<string, FieldRecord>([
      ['User.email', { parent: 'User', field: 'email', type: 'string' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['User.emailAddress', { parent: 'User', field: 'emailAddress', type: 'string' }],
    ]);
    const changes: BreakingChange[] = [{ field: 'email', parent: 'User', change: 'DELETED' }];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([
      { field: 'email', parent: 'User', change: 'DELETED', renamedTo: 'emailAddress' },
    ]);
  });

  it('6. TYPE_MUTATED change passed through unchanged, no renamedTo property at all', () => {
    const oldMap = new Map<string, FieldRecord>([
      ['User.age', { parent: 'User', field: 'age', type: 'integer' }],
    ]);
    const newMap = new Map<string, FieldRecord>([
      ['User.age', { parent: 'User', field: 'age', type: 'string' }],
    ]);
    const changes: BreakingChange[] = [
      {
        field: 'age',
        parent: 'User',
        change: 'TYPE_MUTATED',
        original: 'integer',
        updated: 'string',
      },
    ];

    const result = annotateRenames(changes, oldMap, newMap);

    expect(result).toEqual([
      {
        field: 'age',
        parent: 'User',
        change: 'TYPE_MUTATED',
        original: 'integer',
        updated: 'string',
      },
    ]);
    expect('renamedTo' in result[0]!).toBe(false);
  });
});
