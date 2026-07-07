import { describe, it, expect } from 'vitest';
import { computeVerdict } from '@/lib/report/verdict';
import type { BreakingChange, UsageMatch } from '@/types/contract';

const deleted = (field: string, parent = 'User'): BreakingChange => ({
  field,
  parent,
  change: 'DELETED',
});

const mutated = (field: string, parent = 'User'): BreakingChange => ({
  field,
  parent,
  change: 'TYPE_MUTATED',
  original: 'integer',
  updated: 'string',
});

const match = (field: string, line: number, column: number): UsageMatch => ({
  field,
  filePath: 'src/x.ts',
  line,
  column,
  kind: 'property-access',
  snippet: `u.${field}`,
});

describe('computeVerdict', () => {
  it('1. no changes, no matches → success, no comment, exact title', () => {
    const v = computeVerdict([], []);
    expect(v.conclusion).toBe('success');
    expect(v.shouldComment).toBe(false);
    expect(v.title).toBe('No breaking schema changes found');
    expect(v.title.length).toBeLessThanOrEqual(120);
  });

  it('2. changes > 0, no matches → success, shouldComment true, title contains count', () => {
    const v = computeVerdict([deleted('phoneNumber'), mutated('age')], []);
    expect(v.conclusion).toBe('success');
    expect(v.shouldComment).toBe(true);
    expect(v.title).toContain('2');
    expect(v.title).toBe('2 schema change(s), no frontend references');
    expect(v.title.length).toBeLessThanOrEqual(120);
  });

  it('3. changes > 0 with matches → failure, title has both counts, summary blocks merge', () => {
    const v = computeVerdict(
      [deleted('phoneNumber')],
      [match('phoneNumber', 1, 1), match('phoneNumber', 2, 3), match('phoneNumber', 4, 5)],
    );
    expect(v.conclusion).toBe('failure');
    expect(v.shouldComment).toBe(true);
    expect(v.title).toContain('3'); // match count
    expect(v.title).toContain('1'); // change count
    expect(v.title).toBe('3 broken frontend reference(s) to 1 schema change(s)');
    expect(v.summary).toContain('Merge is blocked');
    expect(v.title.length).toBeLessThanOrEqual(120);
  });

  it('4. impossible row (0 changes, 2 matches) → row-1 verdict (changes-count wins)', () => {
    const v = computeVerdict([], [match('phoneNumber', 1, 1), match('age', 2, 2)]);
    expect(v.conclusion).toBe('success');
    expect(v.shouldComment).toBe(false);
    expect(v.title).toBe('No breaking schema changes found');
  });

  it('is pure — identical inputs yield identical output', () => {
    const changes = [deleted('phoneNumber')];
    const matches = [match('phoneNumber', 3, 7)];
    expect(computeVerdict(changes, matches)).toEqual(computeVerdict(changes, matches));
  });
});
