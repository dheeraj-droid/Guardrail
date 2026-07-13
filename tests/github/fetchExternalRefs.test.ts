import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from 'octokit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveSpecRefs } from '@/lib/github/fetchExternalRefs';
import { parseOpenApiSpec } from '@/lib/diff/parseSpec';
import { flattenOpenApiFields } from '@/lib/diff/flattenSchema';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'multi-file-spec');
const readFixture = (relativePath: string) => readFileSync(join(fixtures, relativePath), 'utf8');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Base64-encode a UTF-8 string the way the GitHub API would. */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** An error shaped like an Octokit request failure. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

interface FixtureFile {
  path: string;
  content: string;
}

/**
 * Mock `octokit.request` for the Contents API route only (Track E's mock pattern):
 * serves `files` keyed by path, 404s anything else. Tracks concurrent in-flight
 * requests via `onFetch` for the bounded-concurrency assertion.
 */
function mockContentsOctokit(
  files: readonly FixtureFile[],
  opts: { delayMs?: number; onActiveChange?: (active: number) => void } = {},
): { octokit: Octokit; request: ReturnType<typeof vi.fn> } {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  let active = 0;
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route !== 'GET /repos/{owner}/{repo}/contents/{path}') {
      throw new Error(`Unexpected route: ${route}`);
    }
    const path = params.path as string;
    active++;
    opts.onActiveChange?.(active);
    if (opts.delayMs) await sleep(opts.delayMs);
    active--;
    const content = byPath.get(path);
    if (content === undefined) {
      throw httpError(404);
    }
    return { data: { content: b64(content), encoding: 'base64' } };
  });
  return { octokit: { request } as unknown as Octokit, request };
}

describe('resolveSpecRefs', () => {
  it('1. zero external refs -> returns the input unchanged, zero octokit.request calls', async () => {
    const { octokit, request } = mockContentsOctokit([]);
    const rootSpec: Record<string, unknown> = {
      components: { schemas: { User: { type: 'object', properties: { id: { type: 'string' } } } } },
    };

    const result = await resolveSpecRefs(octokit, {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      rootSpec,
      rootPath: 'openapi.json',
      maxDepth: 5,
      concurrency: 8,
    });

    expect(result).toBe(rootSpec);
    expect(request).not.toHaveBeenCalled();
  });

  it('2. one external ref, successfully fetched -> merged spec flattens the external field', async () => {
    const rootSpec = parseOpenApiSpec(readFixture('base/openapi.json'), 'openapi.json');
    const { octokit } = mockContentsOctokit([
      { path: 'schemas/user.yaml', content: readFixture('base/schemas/user.yaml') },
    ]);

    const merged = await resolveSpecRefs(octokit, {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      rootSpec,
      rootPath: 'openapi.json',
      maxDepth: 5,
      concurrency: 8,
    });

    const fields = flattenOpenApiFields(merged);
    expect(fields.has('schemas/user.yaml#User.phoneNumber')).toBe(true);
    expect(fields.has('schemas/user.yaml#User.email')).toBe(true);
  });

  it('2b. deleting the field in the head fixture is absent from the flattened map', async () => {
    const rootSpec = parseOpenApiSpec(readFixture('head/openapi.json'), 'openapi.json');
    const { octokit } = mockContentsOctokit([
      { path: 'schemas/user.yaml', content: readFixture('head/schemas/user.yaml') },
    ]);

    const merged = await resolveSpecRefs(octokit, {
      owner: 'o',
      repo: 'r',
      ref: 'head-sha',
      rootSpec,
      rootPath: 'openapi.json',
      maxDepth: 5,
      concurrency: 8,
    });

    const fields = flattenOpenApiFields(merged);
    expect(fields.has('schemas/user.yaml#User.phoneNumber')).toBe(false);
    expect(fields.has('schemas/user.yaml#User.email')).toBe(true);
  });

  it('3. target 404s (FileNotFoundError) -> ref stays unresolved, no throw', async () => {
    const rootSpec: Record<string, unknown> = {
      components: {
        schemas: {
          Wrapper: {
            type: 'object',
            properties: { user: { $ref: './schemas/user.yaml#/User' } },
          },
        },
      },
    };
    const { octokit } = mockContentsOctokit([]); // nothing found -> 404 on every fetch

    const merged = await resolveSpecRefs(octokit, {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      rootSpec,
      rootPath: 'openapi.json',
      maxDepth: 5,
      concurrency: 8,
    });

    const components = merged.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    const wrapper = schemas.Wrapper as Record<string, unknown>;
    const properties = wrapper.properties as Record<string, unknown>;
    const user = properties.user as Record<string, unknown>;
    // Left untouched (still the opaque original ref) -- never thrown.
    expect(user.$ref).toBe('./schemas/user.yaml#/User');
  });

  it('4. cyclic refs (a.json -> b.json -> a.json) resolve without hanging; each fetched at most once', async () => {
    const rootSpec: Record<string, unknown> = {
      components: {
        schemas: {
          Root: { $ref: './a.json#/Frag' },
        },
      },
    };
    const aJson = JSON.stringify({
      components: { schemas: { Frag: { $ref: './b.json#/Frag' } } },
    });
    const bJson = JSON.stringify({
      components: { schemas: { Frag: { $ref: './a.json#/Frag' } } },
    });
    const { octokit, request } = mockContentsOctokit([
      { path: 'a.json', content: aJson },
      { path: 'b.json', content: bJson },
    ]);

    const merged = await resolveSpecRefs(octokit, {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      rootSpec,
      rootPath: 'openapi.json',
      maxDepth: 5,
      concurrency: 8,
    });

    const aCalls = request.mock.calls.filter(([, params]) => (params as { path: string }).path === 'a.json');
    const bCalls = request.mock.calls.filter(([, params]) => (params as { path: string }).path === 'b.json');
    expect(aCalls).toHaveLength(1);
    expect(bCalls).toHaveLength(1);

    const components = merged.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(schemas['a.json#Frag']).toBeDefined();
    expect(schemas['b.json#Frag']).toBeDefined();
  });

  it('5. a chain deeper than maxDepth leaves the tail unresolved; no throw', async () => {
    const rootSpec: Record<string, unknown> = {
      components: { schemas: { Root: { $ref: './level0.json#/Frag' } } },
    };
    const level0 = JSON.stringify({
      components: { schemas: { Frag: { $ref: './level1.json#/Frag' } } },
    });
    const level1 = JSON.stringify({
      components: { schemas: { Frag: { type: 'object', properties: { deep: { type: 'string' } } } } },
    });
    const { octokit, request } = mockContentsOctokit([
      { path: 'level0.json', content: level0 },
      { path: 'level1.json', content: level1 },
    ]);

    const merged = await resolveSpecRefs(octokit, {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      rootSpec,
      rootPath: 'openapi.json',
      maxDepth: 1, // only the root's own direct ref (level0) gets fetched
      concurrency: 8,
    });

    expect(request).toHaveBeenCalledTimes(1);
    const components = merged.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(schemas['level0.json#Frag']).toBeDefined();
    expect(schemas['level1.json#Frag']).toBeUndefined();
  });

  it('6. bounded concurrency: N refs, concurrency 2 -> at most 2 octokit.request calls in flight', async () => {
    const rootSpec: Record<string, unknown> = {
      components: {
        schemas: {
          A: { $ref: './f0.json#/X' },
          B: { $ref: './f1.json#/X' },
          C: { $ref: './f2.json#/X' },
          D: { $ref: './f3.json#/X' },
        },
      },
    };
    const files: FixtureFile[] = [0, 1, 2, 3].map((i) => ({
      path: `f${i}.json`,
      content: JSON.stringify({ components: { schemas: { X: { type: 'object' } } } }),
    }));

    let active = 0;
    let maxActive = 0;
    const { octokit } = mockContentsOctokit(files, {
      delayMs: 15,
      onActiveChange: (n) => {
        active = n;
        maxActive = Math.max(maxActive, active);
      },
    });

    await resolveSpecRefs(octokit, {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      rootSpec,
      rootPath: 'openapi.json',
      maxDepth: 5,
      concurrency: 2,
    });

    expect(maxActive).toBe(2);
  });
});
