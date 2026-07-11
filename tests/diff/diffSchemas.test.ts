import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOpenApiSpec } from '@/lib/diff/parseSpec';
import { diffOpenApiSchemas } from '@/lib/diff/diffSchemas';
import type { BreakingChange } from '@/types/contract';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'openapi');
const readFixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

const v1 = parseOpenApiSpec(readFixture('user-v1.json'), 'user-v1.json');
const v2 = parseOpenApiSpec(readFixture('user-v2.json'), 'user-v2.json');

describe('diffOpenApiSchemas', () => {
  it('returns exactly the expected breaking changes in order for v1 -> v2', () => {
    const changes = diffOpenApiSchemas(v1, v2);

    // Ordered by the spec's deterministic sort: parent asc, then field asc
    // (plain < compare). Note 'User' < 'User.address', so the User.* fields
    // precede User.address.street. This applies File 3's stated sort algorithm,
    // which is authoritative over the prose ordering in the acceptance listing.
    const expected: BreakingChange[] = [
      {
        field: 'nickname',
        parent: 'POST /users request',
        change: 'TYPE_MUTATED',
        original: 'string',
        updated: 'integer',
      },
      {
        field: 'age',
        parent: 'User',
        change: 'TYPE_MUTATED',
        original: 'integer',
        updated: 'string',
      },
      {
        field: 'phoneNumber',
        parent: 'User',
        change: 'DELETED',
        // v1 -> v2 also adds User.middleName (string) — same parent, same type, but
        // NOT name-related (no shared camelCase word, no substring relation), so
        // annotateRenames' name-relation gate correctly does NOT flag this as a
        // rename. (This pair is exactly the real false-positive that gate exists to
        // prevent — see tests/diff/detectRenames.test.ts test 7.)
      },
      {
        field: 'street',
        parent: 'User.address',
        change: 'DELETED',
      },
    ];

    expect(changes).toEqual(expected);

    // Independently assert the exact multiset the spec enumerates in test 5,
    // order-agnostic, so the required changes are all present and nothing extra.
    expect(changes).toHaveLength(4);
    expect(changes).toContainEqual({
      field: 'nickname',
      parent: 'POST /users request',
      change: 'TYPE_MUTATED',
      original: 'string',
      updated: 'integer',
    });
    expect(changes).toContainEqual({
      field: 'street',
      parent: 'User.address',
      change: 'DELETED',
    });
    expect(changes).toContainEqual({
      field: 'age',
      parent: 'User',
      change: 'TYPE_MUTATED',
      original: 'integer',
      updated: 'string',
    });
    expect(changes).toContainEqual({
      field: 'phoneNumber',
      parent: 'User',
      change: 'DELETED',
    });
  });

  it('does not report the added middleName field', () => {
    const changes = diffOpenApiSchemas(v1, v2);
    expect(changes.some((c) => c.field === 'middleName')).toBe(false);
  });

  it('DELETED entries carry no original/updated keys', () => {
    const changes = diffOpenApiSchemas(v1, v2);
    const deleted = changes.filter((c) => c.change === 'DELETED');
    expect(deleted.length).toBeGreaterThan(0);
    for (const c of deleted) {
      expect('original' in c).toBe(false);
      expect('updated' in c).toBe(false);
    }
  });

  it('returns [] for identical specs', () => {
    expect(diffOpenApiSchemas(v1, v1)).toEqual([]);

    const v2copy = parseOpenApiSpec(readFixture('user-v2.json'), 'user-v2.json');
    expect(diffOpenApiSchemas(v2, v2copy)).toEqual([]);
  });

  it('treats a format change as a TYPE_MUTATED (integer -> integer(int64))', () => {
    const oldSpec: Record<string, unknown> = {
      components: {
        schemas: {
          Widget: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      },
    };
    const newSpec: Record<string, unknown> = {
      components: {
        schemas: {
          Widget: {
            type: 'object',
            properties: { id: { type: 'integer', format: 'int64' } },
          },
        },
      },
    };

    expect(diffOpenApiSchemas(oldSpec, newSpec)).toEqual([
      {
        field: 'id',
        parent: 'Widget',
        change: 'TYPE_MUTATED',
        original: 'integer',
        updated: 'integer(int64)',
      },
    ]);
  });

  it('sorts by parent asc then field asc', () => {
    const oldSpec: Record<string, unknown> = {
      components: {
        schemas: {
          Zeta: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } } },
          Alpha: { type: 'object', properties: { y: { type: 'string' } } },
        },
      },
    };
    // Delete everything in new spec.
    const newSpec: Record<string, unknown> = { components: { schemas: {} } };

    const changes = diffOpenApiSchemas(oldSpec, newSpec);
    expect(changes.map((c) => `${c.parent}.${c.field}`)).toEqual([
      'Alpha.y',
      'Zeta.a',
      'Zeta.b',
    ]);
  });

  it('annotates an unambiguous rename with renamedTo (wiring, Spec M)', () => {
    const oldSpec: Record<string, unknown> = {
      components: {
        schemas: {
          User: { type: 'object', properties: { age: { type: 'integer' } } },
        },
      },
    };
    const newSpec: Record<string, unknown> = {
      components: {
        schemas: {
          User: { type: 'object', properties: { ageYears: { type: 'integer' } } },
        },
      },
    };

    const changes = diffOpenApiSchemas(oldSpec, newSpec);
    expect(changes).toEqual([
      { field: 'age', parent: 'User', change: 'DELETED', renamedTo: 'ageYears' },
    ]);
  });
});
