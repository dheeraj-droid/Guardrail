import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOpenApiSpec, SpecParseError } from '@/lib/diff/parseSpec';
import { flattenOpenApiFields } from '@/lib/diff/flattenSchema';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'openapi');
const readFixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

describe('parseOpenApiSpec', () => {
  it('parses the JSON fixture into a root object', () => {
    const spec = parseOpenApiSpec(readFixture('user-v1.json'), 'user-v1.json');
    expect(spec).toBeTypeOf('object');
    expect(spec.openapi).toBe('3.0.3');
  });

  it('parses the YAML fixture into a root object', () => {
    const spec = parseOpenApiSpec(readFixture('user-v1.yaml'), 'user-v1.yaml');
    expect(spec).toBeTypeOf('object');
    expect(spec.openapi).toBe('3.0.3');
  });

  it('JSON and YAML fixtures produce equal flatten maps', () => {
    const jsonSpec = parseOpenApiSpec(readFixture('user-v1.json'), 'user-v1.json');
    const yamlSpec = parseOpenApiSpec(readFixture('user-v1.yaml'), 'user-v1.yaml');

    const jsonMap = flattenOpenApiFields(jsonSpec);
    const yamlMap = flattenOpenApiFields(yamlSpec);

    // Same key set.
    expect([...yamlMap.keys()].sort()).toEqual([...jsonMap.keys()].sort());
    // Same records per key.
    for (const [key, rec] of jsonMap) {
      expect(yamlMap.get(key)).toEqual(rec);
    }
  });

  it('parses a .txt file containing YAML via fallback', () => {
    const raw = 'openapi: 3.0.3\ninfo:\n  title: X\n  version: 1.0.0\n';
    const spec = parseOpenApiSpec(raw, 'spec.txt');
    expect(spec.openapi).toBe('3.0.3');
  });

  it('throws SpecParseError on garbage text', () => {
    expect(() => parseOpenApiSpec('{ this is not: valid: json: or yaml [', 'spec.txt')).toThrow(
      SpecParseError,
    );
  });

  it('throws SpecParseError on empty string', () => {
    let thrown: unknown;
    try {
      parseOpenApiSpec('', 'empty.json');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SpecParseError);
    expect((thrown as SpecParseError).message).toBe('Spec file is empty');
  });

  it('throws SpecParseError on whitespace-only string', () => {
    expect(() => parseOpenApiSpec('   \n  \t ', 'empty.yaml')).toThrow(SpecParseError);
  });

  it('throws SpecParseError when root is a bare string', () => {
    let thrown: unknown;
    try {
      parseOpenApiSpec('"hello"', 'root.json');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SpecParseError);
    expect((thrown as SpecParseError).message).toBe('Spec root is not an object');
  });

  it('throws SpecParseError when root is an array', () => {
    expect(() => parseOpenApiSpec('[1, 2, 3]', 'root.json')).toThrow(SpecParseError);
  });

  it('carries filePath and cause on a wrapped JSON error', () => {
    let thrown: unknown;
    try {
      parseOpenApiSpec('{ broken', 'broken.json');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SpecParseError);
    expect((thrown as SpecParseError).filePath).toBe('broken.json');
    expect((thrown as SpecParseError).cause).toBeInstanceOf(Error);
  });
});
