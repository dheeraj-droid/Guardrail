import { describe, it, expect } from 'vitest';
import { aggregateVerdicts } from '@/lib/report/aggregateVerdicts';
import { computeVerdict } from '@/lib/report/verdict';
import type { LinkOutcome } from '@/lib/pipeline/processPullRequest';
import type { ProjectLink } from '@/types/db';
import type { BreakingChange, UsageMatch } from '@/types/contract';

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

const CHANGES: BreakingChange[] = [{ field: 'phoneNumber', parent: 'User', change: 'DELETED' }];
const MATCHES: UsageMatch[] = [
  {
    field: 'phoneNumber',
    filePath: 'src/a.ts',
    line: 1,
    column: 1,
    kind: 'property-access',
    snippet: 'u.phoneNumber',
  },
];

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
    scan: { matches, scannedFileCount: 10, truncated: false },
    verdict: computeVerdict(changes, matches),
  };
}

describe('aggregateVerdicts', () => {
  it('1. singleton evaluated outcome with changes -> output equals outcome.verdict exactly', () => {
    const outcome = evaluatedOutcome({ changes: CHANGES, matches: MATCHES });
    const result = aggregateVerdicts([outcome]);
    expect(result).toEqual(outcome.kind === 'evaluated' ? outcome.verdict : undefined);
  });

  it('2. singleton no-spec outcome -> exact "OpenAPI spec not found" strings', () => {
    const link = makeLink({ openapi_file_path: 'api/openapi.json' });
    const result = aggregateVerdicts([{ kind: 'no-spec', link }]);
    expect(result.conclusion).toBe('neutral');
    expect(result.title).toBe('OpenAPI spec not found');
    expect(result.summary).toBe(
      'No OpenAPI spec was found at `api/openapi.json` on either the base or head ref.',
    );
    expect(result.shouldComment).toBe(false);
  });

  it('3a. singleton spec-added outcome -> exact strings', () => {
    const link = makeLink({ openapi_file_path: 'api/openapi.json' });
    const result = aggregateVerdicts([{ kind: 'spec-added', link }]);
    expect(result.conclusion).toBe('success');
    expect(result.title).toBe('New OpenAPI spec added');
    expect(result.summary).toBe(
      'A new OpenAPI spec was added at `api/openapi.json`. There is no previous contract to compare against.',
    );
    expect(result.shouldComment).toBe(false);
  });

  it('3b. singleton spec-removed outcome -> exact strings', () => {
    const link = makeLink({ openapi_file_path: 'api/openapi.json' });
    const result = aggregateVerdicts([{ kind: 'spec-removed', link }]);
    expect(result.conclusion).toBe('neutral');
    expect(result.title).toBe('OpenAPI spec was removed');
    expect(result.summary).toBe(
      'The OpenAPI spec at `api/openapi.json` was removed in this PR. Guardrail cannot diff a removed contract — please review the frontend impact manually.',
    );
    expect(result.shouldComment).toBe(false);
  });

  it('3c. singleton spec-unparseable outcome -> exact strings', () => {
    const link = makeLink({ openapi_file_path: 'api/openapi.json' });
    const result = aggregateVerdicts([{ kind: 'spec-unparseable', link, message: 'Failed to parse JSON spec' }]);
    expect(result.conclusion).toBe('neutral');
    expect(result.title).toBe('OpenAPI spec unparseable');
    expect(result.summary).toBe(
      'Guardrail could not parse the OpenAPI spec at `api/openapi.json`: Failed to parse JSON spec',
    );
    expect(result.shouldComment).toBe(false);
  });

  it('3d. singleton frontend-unreachable outcome -> exact strings', () => {
    const link = makeLink({ frontend_repo_id: 999 });
    const result = aggregateVerdicts([{ kind: 'frontend-unreachable', link }]);
    expect(result.conclusion).toBe('neutral');
    expect(result.title).toBe('Frontend repository unreachable');
    expect(result.summary).toBe(
      'Guardrail could not access the linked frontend repository (id 999). Ensure the GitHub App installation covers this repository.',
    );
    expect(result.shouldComment).toBe(false);
  });

  it('3e. singleton internal-error outcome -> exact strings', () => {
    const link = makeLink();
    const result = aggregateVerdicts([{ kind: 'internal-error', link, message: 'boom' }]);
    expect(result.conclusion).toBe('neutral');
    expect(result.title).toBe('Guardrail internal error');
    expect(result.summary).toBe(
      'Guardrail hit an unexpected error and did not evaluate this PR. Merges are not blocked. Error: boom',
    );
    expect(result.shouldComment).toBe(false);
  });

  it('4. two outcomes, one failure evaluated + one success evaluated -> aggregate failure (worst-wins)', () => {
    const failing = evaluatedOutcome({
      link: makeLink({ id: 'a' }),
      changes: CHANGES,
      matches: MATCHES,
      frontendRepoFullName: 'acme/broken',
    });
    const clean = evaluatedOutcome({
      link: makeLink({ id: 'b' }),
      changes: [],
      matches: [],
      frontendRepoFullName: 'acme/clean',
    });
    const result = aggregateVerdicts([failing, clean]);
    expect(result.conclusion).toBe('failure');
  });

  it('5. internal-error (neutral) + zero-change success evaluated -> aggregate neutral, not silently success', () => {
    const errored: LinkOutcome = { kind: 'internal-error', link: makeLink({ id: 'a' }), message: 'oops' };
    const clean = evaluatedOutcome({ link: makeLink({ id: 'b' }), changes: [], matches: [] });
    const result = aggregateVerdicts([errored, clean]);
    expect(result.conclusion).toBe('neutral');
  });

  it('6. internal-error (neutral) + failure evaluated -> aggregate failure (real failure not diluted)', () => {
    const errored: LinkOutcome = { kind: 'internal-error', link: makeLink({ id: 'a' }), message: 'oops' };
    const failing = evaluatedOutcome({ link: makeLink({ id: 'b' }), changes: CHANGES, matches: MATCHES });
    const result = aggregateVerdicts([errored, failing]);
    expect(result.conclusion).toBe('failure');
  });

  it('7. all outcomes success / non-evaluated-non-error -> aggregate success', () => {
    const clean = evaluatedOutcome({ link: makeLink({ id: 'a' }), changes: [], matches: [] });
    const added: LinkOutcome = { kind: 'spec-added', link: makeLink({ id: 'b' }) };
    const result = aggregateVerdicts([clean, added]);
    expect(result.conclusion).toBe('success');
  });

  it('8. shouldComment true iff at least one outcome is evaluated with changes.length > 0', () => {
    const added: LinkOutcome = { kind: 'spec-added', link: makeLink({ id: 'a' }) };
    const zeroChange = evaluatedOutcome({ link: makeLink({ id: 'b' }), changes: [], matches: [] });
    const result = aggregateVerdicts([added, zeroChange]);
    expect(result.shouldComment).toBe(false);

    const withReferences = evaluatedOutcome({ link: makeLink({ id: 'c' }), changes: CHANGES, matches: MATCHES });
    const result2 = aggregateVerdicts([added, withReferences]);
    expect(result2.shouldComment).toBe(true);
  });
});
