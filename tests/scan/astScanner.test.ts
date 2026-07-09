import { describe, it, expect } from 'vitest';
import { scanSourceForFields } from '@/lib/scan/astScanner';

// Spec C targets for these acceptance tests.
const TARGETS = new Set(['phoneNumber', 'age']);

const scan = (
  sourceText: string,
  filePath = 'src/component.ts',
  targetFields: ReadonlySet<string> = TARGETS,
) => scanSourceForFields({ filePath, sourceText, targetFields });

describe('scanSourceForFields', () => {
  // Acceptance 1: property access with correct 1-based line/column and snippet.
  it('matches direct property access with 1-based position and snippet', () => {
    const src = ['const x = 1;', 'const p = resp.data.phoneNumber;'].join('\n');
    const matches = scan(src);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.field).toBe('phoneNumber');
    expect(m.kind).toBe('property-access');
    expect(m.line).toBe(2); // 1-based: second line
    // `const p = resp.data.phoneNumber;` — `phoneNumber` starts at 0-based index 20 → 1-based 21.
    expect(m.column).toBe(21);
    expect(m.snippet).toBe('const p = resp.data.phoneNumber;');
    expect(m.filePath).toBe('src/component.ts');
  });

  // Acceptance 2: shorthand destructuring.
  it('matches shorthand object destructuring', () => {
    const matches = scan('const { phoneNumber } = userData;');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.field).toBe('phoneNumber');
    expect(matches[0]!.kind).toBe('destructuring');
  });

  // Acceptance 3: THE ALIAS LAW (Law 6). Match the source key, never the alias.
  it('matches the source key of an aliased destructure, not the alias', () => {
    const src = 'const { phoneNumber: phone } = user;';
    const matches = scan(src);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.field).toBe('phoneNumber');
    expect(matches[0]!.kind).toBe('destructuring');
    // Scanning the same source for the ALIAS `phone` must yield nothing.
    expect(scan(src, 'src/component.ts', new Set(['phone']))).toHaveLength(0);
  });

  // Acceptance 4: string-literal key.
  it('matches a string-literal destructuring key', () => {
    const matches = scan('const { "phoneNumber": p } = u;');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.field).toBe('phoneNumber');
    expect(matches[0]!.kind).toBe('destructuring');
  });

  // Acceptance 5: computed key is dynamic → skipped even if the identifier is a target.
  it('skips computed destructuring keys', () => {
    // `key` is in targets, but `[key]` is a computed (dynamic) property → no match.
    const matches = scan('const { [key]: v } = u;', 'src/component.ts', new Set(['key']));
    expect(matches).toHaveLength(0);
  });

  // Acceptance 6: rest element binds the remainder, not a named key.
  it('skips rest elements in destructuring', () => {
    const matches = scan('const { ...rest } = u;', 'src/component.ts', new Set(['rest']));
    expect(matches).toHaveLength(0);
  });

  // Acceptance 7: array binding is positional, not a key.
  it('skips array-binding elements', () => {
    // `age` here is a positional binding, NOT a property key → no match.
    const matches = scan('const [age] = rows;');
    expect(matches).toHaveLength(0);
  });

  // Acceptance 8: optional chaining is still a PropertyAccessExpression.
  it('matches optional-chained property access', () => {
    const matches = scan('const p = user?.phoneNumber;');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.field).toBe('phoneNumber');
    expect(matches[0]!.kind).toBe('property-access');
  });

  // Acceptance 9: TSX parsing works; the same text as .ts must not crash.
  it('parses JSX member access in a .tsx file and does not crash as .ts', () => {
    const src = 'const El = () => <span>{user.phoneNumber}</span>;';
    const tsxMatches = scan(src, 'src/component.tsx');
    expect(tsxMatches).toHaveLength(1);
    expect(tsxMatches[0]!.field).toBe('phoneNumber');
    // Same text as .ts: assert only that it does not throw (result may differ).
    expect(() => scan(src, 'src/component.ts')).not.toThrow();
  });

  // Acceptance 10: multiple hits on one line at different columns.
  it('records multiple matches on the same line at different columns', () => {
    const matches = scan('const total = a.age + b.age;');
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.field === 'age')).toBe(true);
    expect(matches[0]!.column).not.toBe(matches[1]!.column);
  });

  // Acceptance 11: irrelevant source yields nothing.
  it('returns [] for source with no target references', () => {
    expect(scan('const x = 1;')).toEqual([]);
  });

  // Acceptance 12: nested destructure — inner phoneNumber is caught naturally.
  it('matches phoneNumber in a nested destructure', () => {
    const matches = scan('const { user: { phoneNumber } } = resp;');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.field).toBe('phoneNumber');
    expect(matches[0]!.kind).toBe('destructuring');
  });

  // Acceptance 13: syntactically broken source must not throw (best-effort parse).
  it('returns without throwing on syntactically broken source', () => {
    expect(() => scan('const { = ;')).not.toThrow();
    // A broken fragment that still contains a valid access should still be reachable.
    expect(() => scan('const { = ; phoneNumber')).not.toThrow();
  });

  // Acceptance 14: WRITING an object literal is NOT one of the two SRD checkpoints.
  // `{ phoneNumber: value }` is a PropertyAssignment (object-literal construction), and
  // `{ phoneNumber }` in a literal is a ShorthandPropertyAssignment — neither is a
  // PropertyAccessExpression nor a BindingElement, so both are intentionally 0 matches.
  it('does not match object-literal property assignments (writes, not reads)', () => {
    expect(scan('const o = { phoneNumber: value };')).toHaveLength(0);
    expect(scan('const o = { phoneNumber };')).toHaveLength(0);
  });

  // Acceptance 15: bracket access with a string-literal key is the same read as dot access.
  it('matches bracket access with a string-literal key as property-access', () => {
    const matches = scan('const p = user["phoneNumber"];');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.field).toBe('phoneNumber');
    expect(matches[0]!.kind).toBe('property-access');
  });

  // Acceptance 16: bracket access with a non-literal (dynamic) key is not statically
  // trackable, even if the identifier used as the key is itself a target field name.
  it('skips bracket access with a dynamic (non-literal) key', () => {
    const matches = scan('const p = user[phoneNumber];', 'src/component.ts', new Set(['phoneNumber']));
    expect(matches).toHaveLength(0);
  });

  // Acceptance 17: multiple bracket-access hits on one line at different columns.
  it('records multiple bracket-access matches at different columns', () => {
    const matches = scan('const total = a["age"] + b["age"];');
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.field === 'age' && m.kind === 'property-access')).toBe(true);
    expect(matches[0]!.column).not.toBe(matches[1]!.column);
  });
});
