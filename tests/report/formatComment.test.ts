import { describe, it, expect } from 'vitest';
import {
  CHECKS_SUMMARY_LIMIT,
  formatAggregatePrComment,
  formatPrComment,
  truncateForChecks,
} from '@/lib/report/formatComment';
import { computeVerdict } from '@/lib/report/verdict';
import type { BreakingChange, ScanReport, UsageMatch } from '@/types/contract';
import type { LinkOutcome } from '@/lib/pipeline/processPullRequest';
import type { ProjectLink } from '@/types/db';

const scan = (
  matches: UsageMatch[],
  scannedFileCount = 10,
  truncated = false,
): ScanReport => ({ matches, scannedFileCount, truncated });

describe('formatPrComment', () => {
  it('5. marker is the first line', () => {
    const out = formatPrComment({
      changes: [],
      scan: scan([]),
      frontendRepoFullName: 'acme/web',
      openapiFilePath: 'openapi.json',
    });
    expect(out.split('\n')[0]).toBe('<!-- guardrail-report -->');
  });

  it('6. golden — exact table rows and grouping order (file asc, line asc, col asc)', () => {
    const changes: BreakingChange[] = [
      { field: 'phoneNumber', parent: 'User', change: 'DELETED' },
      { field: 'age', parent: 'User', change: 'TYPE_MUTATED', original: 'integer', updated: 'string' },
    ];
    // Deliberately out of order: Profile.tsx after Header.tsx; lines/cols shuffled.
    const matches: UsageMatch[] = [
      {
        field: 'phoneNumber',
        filePath: 'src/components/Profile.tsx',
        line: 42,
        column: 18,
        kind: 'property-access',
        snippet: 'const p = user.phoneNumber;',
      },
      {
        field: 'age',
        filePath: 'src/components/Profile.tsx',
        line: 7,
        column: 9,
        kind: 'destructuring',
        snippet: 'const { age } = user;',
      },
      {
        field: 'phoneNumber',
        filePath: 'src/api/Header.tsx',
        line: 3,
        column: 5,
        kind: 'property-access',
        snippet: 'return u.phoneNumber;',
      },
    ];

    const out = formatPrComment({
      changes,
      scan: scan(matches, 128),
      frontendRepoFullName: 'acme/web',
      openapiFilePath: 'api/openapi.json',
    });
    const lines = out.split('\n');

    // Header block.
    expect(lines[0]).toBe('<!-- guardrail-report -->');
    expect(lines[1]).toBe('## Guardrail Contract Report');
    expect(out).toContain('Analyzed `api/openapi.json` against frontend `acme/web`.');

    // Schema changes table — exact rows.
    expect(out).toContain('### Schema changes (2)');
    expect(out).toContain('| Field | Parent | Change | Old type | New type |');
    expect(out).toContain('|---|---|---|---|---|');
    expect(out).toContain('| `phoneNumber` | `User` | DELETED | — | — |');
    expect(out).toContain('| `age` | `User` | TYPE_MUTATED | `integer` | `string` |');

    // Broken references heading with count.
    expect(out).toContain('### Broken frontend references (3)');

    // Grouping: files sorted ascending → Header.tsx group appears before Profile.tsx.
    const headerHeadingIdx = lines.indexOf('**`src/api/Header.tsx`**');
    const profileHeadingIdx = lines.indexOf('**`src/components/Profile.tsx`**');
    expect(headerHeadingIdx).toBeGreaterThan(-1);
    expect(profileHeadingIdx).toBeGreaterThan(-1);
    expect(headerHeadingIdx).toBeLessThan(profileHeadingIdx);

    // Within Profile.tsx: line 7 (col 9) before line 42 (col 18).
    const age7Idx = lines.indexOf(
      '- Line 7, col 9 — `age` (destructuring): `const { age } = user;`',
    );
    const phone42Idx = lines.indexOf(
      '- Line 42, col 18 — `phoneNumber` (property-access): `const p = user.phoneNumber;`',
    );
    expect(age7Idx).toBeGreaterThan(-1);
    expect(phone42Idx).toBeGreaterThan(-1);
    expect(age7Idx).toBeLessThan(phone42Idx);

    // Header.tsx bullet exact string.
    expect(out).toContain(
      '- Line 3, col 5 — `phoneNumber` (property-access): `return u.phoneNumber;`',
    );

    // Footer with scanned count, no truncation warning.
    expect(out).toContain('---');
    expect(out).toContain('_Scanned 128 file(s)._');
    expect(out).not.toContain('File list was truncated');
  });

  it('7. M == 0 → italics "safe to merge" line, no broken-references heading', () => {
    const out = formatPrComment({
      changes: [{ field: 'phoneNumber', parent: 'User', change: 'DELETED' }],
      scan: scan([], 5),
      frontendRepoFullName: 'acme/web',
      openapiFilePath: 'openapi.json',
    });
    expect(out).toContain('_No frontend references found — safe to merge._');
    expect(out).not.toContain('### Broken frontend references');
    // Schema changes table still present.
    expect(out).toContain('### Schema changes (1)');
    expect(out).toContain('| `phoneNumber` | `User` | DELETED | — | — |');
  });

  it('8. truncated flag → footer warning sentence present', () => {
    const out = formatPrComment({
      changes: [{ field: 'phoneNumber', parent: 'User', change: 'DELETED' }],
      scan: scan([], 2000, true),
      frontendRepoFullName: 'acme/web',
      openapiFilePath: 'openapi.json',
    });
    expect(out).toContain(
      '_Scanned 2000 file(s)._ ⚠️ File list was truncated (MAX_SCAN_FILES or GitHub tree cap) — results may be incomplete.',
    );
  });

  it('10. snippet containing a pipe is escaped so the table stays intact', () => {
    const out = formatPrComment({
      changes: [{ field: 'age', parent: 'User', change: 'DELETED' }],
      scan: scan([
        {
          field: 'age',
          filePath: 'src/a.ts',
          line: 1,
          column: 1,
          kind: 'property-access',
          snippet: 'const x = a.age | 0;',
        },
      ]),
      frontendRepoFullName: 'acme/web',
      openapiFilePath: 'openapi.json',
    });
    expect(out).toContain('a.age \\| 0');
    // Raw (unescaped) pipe from the snippet must not appear.
    expect(out).not.toContain('a.age | 0');
  });

  it('11. DELETED with renamedTo renders a rename hint; DELETED without it stays plain', () => {
    const out = formatPrComment({
      changes: [
        { field: 'age', parent: 'User', change: 'DELETED', renamedTo: 'ageYears' },
        { field: 'phoneNumber', parent: 'User', change: 'DELETED' },
      ],
      scan: scan([]),
      frontendRepoFullName: 'acme/web',
      openapiFilePath: 'openapi.json',
    });
    expect(out).toContain('| `age` | `User` | DELETED (looks renamed to `ageYears`) | — | — |');
    expect(out).toContain('| `phoneNumber` | `User` | DELETED | — | — |');
  });
});

describe('truncateForChecks', () => {
  it('exported constant is 65535', () => {
    expect(CHECKS_SUMMARY_LIMIT).toBe(65535);
  });

  it('9a. short string is returned unchanged', () => {
    const s = 'hello world\n| a | b |';
    expect(truncateForChecks(s)).toBe(s);
  });

  it('9b. a string exactly at the limit is unchanged', () => {
    const s = 'x'.repeat(CHECKS_SUMMARY_LIMIT);
    expect(truncateForChecks(s)).toBe(s);
    expect(truncateForChecks(s).length).toBe(CHECKS_SUMMARY_LIMIT);
  });

  it('9c. 100k chars with no newlines → length <= 65535 and ends with the note', () => {
    const s = 'a'.repeat(100_000);
    const out = truncateForChecks(s);
    expect(out.length).toBeLessThanOrEqual(CHECKS_SUMMARY_LIMIT);
    expect(out.endsWith('…truncated by Guardrail (output limit).')).toBe(true);
  });

  it('9d. over-limit input cuts back to the last newline inside the slice', () => {
    // Build > limit: a newline near the reserve boundary, then filler with no newline.
    const head = 'y'.repeat(CHECKS_SUMMARY_LIMIT - 100) + '\n';
    const s = head + 'z'.repeat(500);
    const out = truncateForChecks(s);
    expect(out.length).toBeLessThanOrEqual(CHECKS_SUMMARY_LIMIT);
    // Body is cut at the newline: no trailing 'z' filler survives before the note.
    expect(out).toBe('y'.repeat(CHECKS_SUMMARY_LIMIT - 100) + '\n\n…truncated by Guardrail (output limit).');
    expect(out.endsWith('…truncated by Guardrail (output limit).')).toBe(true);
  });
});

// ---- Spec P — formatAggregatePrComment (Wave V2 multi-link composer) ------------------

function makeLink(overrides: Partial<ProjectLink> = {}): ProjectLink {
  return {
    id: 'link-1',
    backend_repo_id: 100,
    frontend_repo_id: 200,
    openapi_file_path: 'openapi.json',
    frontend_src_directory: 'src',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function evaluatedOutcome(opts: {
  link?: ProjectLink;
  changes?: BreakingChange[];
  matches?: UsageMatch[];
  frontendRepoFullName?: string;
}): LinkOutcome {
  const link = opts.link ?? makeLink();
  const changes = opts.changes ?? [];
  const matches = opts.matches ?? [];
  return {
    kind: 'evaluated',
    link,
    frontendRepoFullName: opts.frontendRepoFullName ?? 'acme/web',
    changes,
    scan: scan(matches),
    verdict: computeVerdict(changes, matches),
  };
}

describe('formatAggregatePrComment', () => {
  it('1. 2 outcomes (one failing, one clean) -> summary table has 2 rows, exactly 1 detail section', () => {
    const failing = evaluatedOutcome({
      link: makeLink({ id: 'a' }),
      changes: [{ field: 'phoneNumber', parent: 'User', change: 'DELETED' }],
      matches: [
        {
          field: 'phoneNumber',
          filePath: 'src/a.ts',
          line: 1,
          column: 1,
          kind: 'property-access',
          snippet: 'u.phoneNumber',
        },
      ],
      frontendRepoFullName: 'acme/broken',
    });
    const clean = evaluatedOutcome({
      link: makeLink({ id: 'b' }),
      changes: [],
      matches: [],
      frontendRepoFullName: 'acme/clean',
    });

    const out = formatAggregatePrComment([failing, clean]);
    const lines = out.split('\n');

    expect(lines[0]).toBe('<!-- guardrail-report -->');

    // Summary table: header + separator + exactly 2 outcome rows.
    const tableRows = lines.filter((l) => l.startsWith('| ') && l.includes(' | '));
    // header row + separator counted separately below; count data rows via frontend labels.
    expect(out).toContain('| `acme/broken` |');
    expect(out).toContain('| `acme/clean` |');
    expect(tableRows.filter((l) => l.includes('acme/broken') || l.includes('acme/clean')).length).toBe(2);

    // Exactly one detail section (the failing one) — the clean one has zero changes,
    // so its own verdict.shouldComment is false and it gets no detail heading.
    expect(out).toContain('### acme/broken');
    expect(out).not.toContain('### acme/clean');
  });

  it('2. singleton evaluated outcome -> byte-identical to formatPrComment called directly', () => {
    const outcome = evaluatedOutcome({
      changes: [{ field: 'age', parent: 'User', change: 'TYPE_MUTATED', original: 'integer', updated: 'string' }],
      matches: [
        {
          field: 'age',
          filePath: 'src/a.ts',
          line: 3,
          column: 2,
          kind: 'destructuring',
          snippet: 'const { age } = user;',
        },
      ],
      frontendRepoFullName: 'acme/solo',
    }) as Extract<LinkOutcome, { kind: 'evaluated' }>;

    const viaAggregate = formatAggregatePrComment([outcome]);
    const viaDirect = formatPrComment({
      changes: outcome.changes,
      scan: outcome.scan,
      frontendRepoFullName: outcome.frontendRepoFullName,
      openapiFilePath: outcome.link.openapi_file_path,
    });

    expect(viaAggregate).toBe(viaDirect);
  });

  it('3. non-evaluated outcome kinds appear in the summary table with a status phrase, never a detail section', () => {
    const removed: LinkOutcome = { kind: 'spec-removed', link: makeLink({ id: 'a', frontend_repo_id: 300 }) };
    const errored: LinkOutcome = { kind: 'internal-error', link: makeLink({ id: 'b', frontend_repo_id: 400 }), message: 'boom' };
    const clean = evaluatedOutcome({ link: makeLink({ id: 'c' }), changes: [], matches: [] });

    const out = formatAggregatePrComment([removed, errored, clean]);

    // Both non-evaluated kinds show up with SOME status phrase, and no '###' detail
    // heading is emitted for either of them.
    expect(out).toContain('repo 300');
    expect(out).toContain('repo 400');
    expect(out).not.toMatch(/### repo 300/);
    expect(out).not.toMatch(/### repo 400/);
    expect(out).toContain('OpenAPI spec was removed');
    expect(out).toContain('Guardrail internal error');
  });
});
