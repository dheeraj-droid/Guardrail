import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOpenApiSpec } from '@/lib/diff/parseSpec';
import { flattenOpenApiFields } from '@/lib/diff/flattenSchema';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'openapi');
const readFixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

describe('flattenOpenApiFields', () => {
  const v1 = parseOpenApiSpec(readFixture('user-v1.json'), 'user-v1.json');
  const map = flattenOpenApiFields(v1);

  it('records User.phoneNumber as string', () => {
    expect(map.get('User.phoneNumber')).toEqual({
      parent: 'User',
      field: 'phoneNumber',
      type: 'string',
    });
  });

  it('records User.age as integer', () => {
    expect(map.get('User.age')).toEqual({
      parent: 'User',
      field: 'age',
      type: 'integer',
    });
  });

  it('records the nested address property itself as object', () => {
    expect(map.get('User.address')).toEqual({
      parent: 'User',
      field: 'address',
      type: 'object',
    });
  });

  it('records the nested User.address.street field', () => {
    expect(map.get('User.address.street')).toEqual({
      parent: 'User.address',
      field: 'street',
      type: 'string',
    });
  });

  it('records the inline requestBody field under the operation parent', () => {
    expect(map.get('POST /users request.nickname')).toEqual({
      parent: 'POST /users request',
      field: 'nickname',
      type: 'string',
    });
  });

  it('does NOT record fields from the $ref response body (covered via components)', () => {
    // The 201 response is a $ref to User, so no "POST /users response 201.*" keys.
    for (const key of map.keys()) {
      expect(key.startsWith('POST /users response')).toBe(false);
    }
  });

  it('terminates on a self-referencing schema and records array<ref:Node>', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              children: {
                type: 'array',
                items: { $ref: '#/components/schemas/Node' },
              },
            },
          },
        },
      },
    };

    const nodeMap = flattenOpenApiFields(spec);
    expect(nodeMap.get('Node.value')).toEqual({
      parent: 'Node',
      field: 'value',
      type: 'string',
    });
    expect(nodeMap.get('Node.children')).toEqual({
      parent: 'Node',
      field: 'children',
      type: 'array<ref:Node>',
    });
  });

  it('recurses into array items that are inline objects (parent[] path)', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Order: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    sku: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    };
    const orderMap = flattenOpenApiFields(spec);
    expect(orderMap.get('Order.items')).toEqual({
      parent: 'Order',
      field: 'items',
      type: 'array<object>',
    });
    expect(orderMap.get('Order.items[].sku')).toEqual({
      parent: 'Order.items[]',
      field: 'sku',
      type: 'string',
    });
  });

  it('flattens allOf inline members under the same parent', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Combined: {
            allOf: [
              { type: 'object', properties: { a: { type: 'string' } } },
              { type: 'object', properties: { b: { type: 'integer' } } },
            ],
          },
        },
      },
    };
    const combinedMap = flattenOpenApiFields(spec);
    expect(combinedMap.get('Combined.a')?.type).toBe('string');
    expect(combinedMap.get('Combined.b')?.type).toBe('integer');
  });

  it('applies format to the type descriptor (integer(int64))', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Widget: {
            type: 'object',
            properties: {
              id: { type: 'integer', format: 'int64' },
            },
          },
        },
      },
    };
    expect(flattenOpenApiFields(spec).get('Widget.id')?.type).toBe('integer(int64)');
  });

  it('describes enum properties as enum(type)', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Status: {
            type: 'object',
            properties: {
              state: { type: 'string', enum: ['on', 'off'] },
            },
          },
        },
      },
    };
    expect(flattenOpenApiFields(spec).get('Status.state')?.type).toBe('enum(string)');
  });

  it('skips malformed fragments silently instead of throwing', () => {
    const spec: Record<string, unknown> = {
      components: { schemas: { Bad: 'not-an-object' } },
      paths: { '/x': { post: 42 } },
    };
    expect(() => flattenOpenApiFields(spec)).not.toThrow();
    expect(flattenOpenApiFields(spec).size).toBe(0);
  });
});
