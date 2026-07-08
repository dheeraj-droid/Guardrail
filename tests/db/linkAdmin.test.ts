import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteProjectLink, listLinksForRepoIds, upsertProjectLink } from '@/lib/db/linkAdmin';

/**
 * A plain chainable stub mimicking the slice of the Supabase query builder surface
 * linkAdmin.ts touches: `select().in()`, `upsert()`, `delete().eq()`. No network, no real
 * client — same spirit as tests/db/projectLinks.test.ts's makeDb().
 */
function makeDb(canned: { data: unknown; error: unknown }) {
  const calls: {
    from?: string;
    select?: string;
    inColumn?: string;
    inValues?: unknown;
    upsertRow?: unknown;
    upsertOptions?: unknown;
    deleteEqColumn?: string;
    deleteEqValue?: unknown;
  } = {};

  const resolved = () => Promise.resolve(canned);

  const builder = {
    select(columns: string) {
      calls.select = columns;
      return {
        in(column: string, values: unknown) {
          calls.inColumn = column;
          calls.inValues = values;
          return resolved();
        },
      };
    },
    upsert(row: unknown, options: unknown) {
      calls.upsertRow = row;
      calls.upsertOptions = options;
      return resolved();
    },
    delete() {
      return {
        eq(column: string, value: unknown) {
          calls.deleteEqColumn = column;
          calls.deleteEqValue = value;
          return resolved();
        },
      };
    },
  };

  const from = vi.fn((table: string) => {
    calls.from = table;
    return builder;
  });

  const db = { from };

  return { db: db as unknown as SupabaseClient, calls, from };
}

const ROW_INPUT = {
  backend_repo_id: 100,
  frontend_repo_id: 200,
  openapi_file_path: 'openapi.json',
  frontend_src_directory: 'src',
  created_by_github_id: 42,
  created_by_login: 'octocat',
};

describe('upsertProjectLink', () => {
  it('17. upserts with onConflict backend_repo_id and the ownership fields intact', async () => {
    const { db, calls } = makeDb({ data: null, error: null });

    await upsertProjectLink(db, ROW_INPUT);

    expect(calls.from).toBe('project_links');
    expect(calls.upsertOptions).toEqual({ onConflict: 'backend_repo_id' });
    expect(calls.upsertRow).toMatchObject(ROW_INPUT);
    expect(typeof (calls.upsertRow as { updated_at: string }).updated_at).toBe('string');
  });

  it("18a. upsert error -> throws containing 'project_links upsert failed'", async () => {
    const { db } = makeDb({ data: null, error: { message: 'boom' } });

    await expect(upsertProjectLink(db, ROW_INPUT)).rejects.toThrow(/project_links upsert failed: boom/);
  });
});

describe('listLinksForRepoIds', () => {
  it('19. empty input -> [] with zero db calls', async () => {
    const { db, from } = makeDb({ data: null, error: null });

    const result = await listLinksForRepoIds(db, []);

    expect(result).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it('finds rows for the given backend repo ids', async () => {
    const rows = [{ id: 'l1', backend_repo_id: 1, frontend_repo_id: 2 }];
    const { db, calls } = makeDb({ data: rows, error: null });

    const result = await listLinksForRepoIds(db, [1, 2, 3]);

    expect(result).toEqual(rows);
    expect(calls.from).toBe('project_links');
    expect(calls.inColumn).toBe('backend_repo_id');
    expect(calls.inValues).toEqual([1, 2, 3]);
  });

  it("18b. list error -> throws containing 'project_links list failed'", async () => {
    const { db } = makeDb({ data: null, error: { message: 'db down' } });

    await expect(listLinksForRepoIds(db, [1])).rejects.toThrow(/project_links list failed: db down/);
  });
});

describe('deleteProjectLink', () => {
  it('20. happy path: deletes by backend_repo_id, no throw', async () => {
    const { db, calls } = makeDb({ data: null, error: null });

    await expect(deleteProjectLink(db, 100)).resolves.toBeUndefined();

    expect(calls.from).toBe('project_links');
    expect(calls.deleteEqColumn).toBe('backend_repo_id');
    expect(calls.deleteEqValue).toBe(100);
  });

  it("18c. delete error -> throws containing 'project_links delete failed'", async () => {
    const { db } = makeDb({ data: null, error: { message: 'nope' } });

    await expect(deleteProjectLink(db, 100)).rejects.toThrow(/project_links delete failed: nope/);
  });
});
