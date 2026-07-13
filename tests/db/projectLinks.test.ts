import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getProjectLinkByBackendRepoId,
  getProjectLinksByBackendRepoId,
} from '@/lib/db/projectLinks';

/**
 * Build a plain chainable stub that mimics the Supabase query builder shape used by
 * projectLinks.ts: `from().select().eq().maybeSingle()` (singular) or
 * `from().select().eq()` awaited directly (plural — real Supabase query builders are
 * themselves thenable). No network, no real client (Spec D acceptance rules — do NOT
 * import createDbClient here).
 *
 * The `.eq()` return value resolves to the canned `{ data, error }` whether or not
 * `.maybeSingle()` is chained afterward. The chain records the table name and filter
 * so tests can assert the query targets project_links correctly.
 */
function makeDb(canned: { data: unknown; error: unknown }) {
  const calls = {
    from: undefined as string | undefined,
    select: undefined as string | undefined,
    eqColumn: undefined as string | undefined,
    eqValue: undefined as unknown,
  };

  const builder = {
    select(columns: string) {
      calls.select = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.eqColumn = column;
      calls.eqValue = value;
      return queryResult;
    },
  };

  // Thenable AND exposes `.maybeSingle()` so both the singular and plural call chains
  // resolve to the same canned `{ data, error }` regardless of which one is used.
  const queryResult = {
    maybeSingle() {
      return Promise.resolve(canned);
    },
    then(
      onFulfilled?: ((value: { data: unknown; error: unknown }) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) {
      return Promise.resolve(canned).then(onFulfilled, onRejected);
    },
  };

  const db = {
    from(table: string) {
      calls.from = table;
      return builder;
    },
  };

  // Cast through unknown: the stub only implements the surface projectLinks.ts touches.
  return { db: db as unknown as SupabaseClient, calls };
}

const FULL_ROW = {
  id: 'link-1',
  backend_repo_id: 100,
  frontend_repo_id: 200,
  openapi_file_path: 'api/openapi.yaml',
  frontend_src_directory: 'app',
  created_at: '2026-01-01T00:00:00Z',
};

describe('getProjectLinkByBackendRepoId', () => {
  it('1. row found -> returned typed object, fields intact', async () => {
    const { db, calls } = makeDb({ data: FULL_ROW, error: null });

    const result = await getProjectLinkByBackendRepoId(db, 100);

    expect(result).toEqual(FULL_ROW);
    // Query shape sanity: correct table + filtered on the backend column.
    expect(calls.from).toBe('project_links');
    expect(calls.eqColumn).toBe('backend_repo_id');
    expect(calls.eqValue).toBe(100);
  });

  it('2. data: null, error: null -> null', async () => {
    const { db } = makeDb({ data: null, error: null });

    const result = await getProjectLinkByBackendRepoId(db, 999);

    expect(result).toBeNull();
  });

  it("3. error: { message: 'boom' } -> throws containing 'boom'", async () => {
    const { db } = makeDb({ data: null, error: { message: 'boom' } });

    await expect(getProjectLinkByBackendRepoId(db, 1)).rejects.toThrow(/boom/);
  });

  it("4. NULL openapi_file_path -> 'openapi.json'; NULL src dir -> 'src'", async () => {
    const rowWithNulls = {
      ...FULL_ROW,
      openapi_file_path: null,
      frontend_src_directory: null,
    };
    const { db } = makeDb({ data: rowWithNulls, error: null });

    const result = await getProjectLinkByBackendRepoId(db, 100);

    expect(result?.openapi_file_path).toBe('openapi.json');
    expect(result?.frontend_src_directory).toBe('src');
  });

  it('5. monorepo row (backend_repo_id === frontend_repo_id === 42) -> returned unchanged', async () => {
    const monorepoRow = {
      ...FULL_ROW,
      id: 'link-mono',
      backend_repo_id: 42,
      frontend_repo_id: 42,
    };
    const { db } = makeDb({ data: monorepoRow, error: null });

    const result = await getProjectLinkByBackendRepoId(db, 42);

    expect(result).toEqual(monorepoRow);
    expect(result?.backend_repo_id).toBe(42);
    expect(result?.frontend_repo_id).toBe(42);
  });
});

describe('getProjectLinksByBackendRepoId', () => {
  it('1. two rows for the same backend_repo_id -> both returned, defaults applied per row', async () => {
    const rowA = { ...FULL_ROW, id: 'link-a', openapi_file_path: null };
    const rowB = { ...FULL_ROW, id: 'link-b', frontend_repo_id: 201 };
    const { db, calls } = makeDb({ data: [rowA, rowB], error: null });

    const result = await getProjectLinksByBackendRepoId(db, 100);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ...rowA, openapi_file_path: 'openapi.json' });
    expect(result[1]).toEqual(rowB);
    expect(calls.from).toBe('project_links');
    expect(calls.eqColumn).toBe('backend_repo_id');
    expect(calls.eqValue).toBe(100);
  });

  it('2. zero rows -> []', async () => {
    const { db } = makeDb({ data: [], error: null });

    const result = await getProjectLinksByBackendRepoId(db, 999);

    expect(result).toEqual([]);
  });

  it("3. error: { message: 'boom' } -> throws containing 'boom'", async () => {
    const { db } = makeDb({ data: null, error: { message: 'boom' } });

    await expect(getProjectLinksByBackendRepoId(db, 1)).rejects.toThrow(/boom/);
  });

  it("4. NULL openapi_file_path in one row -> defaulted to 'openapi.json' (shared toProjectLink helper)", async () => {
    const rowWithNulls = {
      ...FULL_ROW,
      openapi_file_path: null,
      frontend_src_directory: null,
    };
    const { db } = makeDb({ data: [rowWithNulls], error: null });

    const result = await getProjectLinksByBackendRepoId(db, 100);

    expect(result).toHaveLength(1);
    expect(result[0]?.openapi_file_path).toBe('openapi.json');
    expect(result[0]?.frontend_src_directory).toBe('src');
  });

  it('6. monorepo row alongside a cross-repo row for the same backend, both returned', async () => {
    const monorepoRow = { ...FULL_ROW, id: 'link-mono', backend_repo_id: 42, frontend_repo_id: 42 };
    const crossRepoRow = { ...FULL_ROW, id: 'link-cross', backend_repo_id: 42, frontend_repo_id: 300 };
    const { db } = makeDb({ data: [monorepoRow, crossRepoRow], error: null });

    const result = await getProjectLinksByBackendRepoId(db, 42);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(monorepoRow);
    expect(result[1]).toEqual(crossRepoRow);
  });
});
