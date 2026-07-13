import { describe, it, expect } from 'vitest';
import { findExternalRefs, mergeExternalRefs } from '@/lib/diff/resolveRefs';

describe('findExternalRefs', () => {
  it('1. finds a relative-path ref inside paths[...].responses[...]', () => {
    const spec: Record<string, unknown> = {
      paths: {
        '/users/{id}': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: './schemas/user.yaml#/User' },
                  },
                },
              },
            },
          },
        },
      },
    };

    const refs = findExternalRefs(spec, '');

    expect(refs).toEqual([
      { raw: './schemas/user.yaml#/User', filePath: 'schemas/user.yaml', fragment: '/User' },
    ]);
  });

  it('1b. finds a relative-path ref inside paths[...].requestBody, resolved against a non-root basePath', () => {
    const spec: Record<string, unknown> = {
      paths: {
        '/users': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '../common/address.yaml#/Address' },
                },
              },
            },
          },
        },
      },
    };

    const refs = findExternalRefs(spec, 'api/specs');

    expect(refs).toEqual([
      {
        raw: '../common/address.yaml#/Address',
        filePath: 'api/common/address.yaml',
        fragment: '/Address',
      },
    ]);
  });

  it('2. does NOT return a #/components/schemas/X same-document ref', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Wrapper: {
            type: 'object',
            properties: {
              user: { $ref: '#/components/schemas/User' },
            },
          },
          User: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
    };

    expect(findExternalRefs(spec, '')).toEqual([]);
  });

  it('3. does NOT return an https://... ref (security boundary)', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Wrapper: {
            type: 'object',
            properties: {
              user: { $ref: 'https://evil.example.com/schemas.json#/User' },
            },
          },
        },
      },
    };

    expect(findExternalRefs(spec, '')).toEqual([]);
  });

  it('3b. does NOT return an http://... ref either', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Wrapper: {
            type: 'object',
            properties: { user: { $ref: 'http://internal.example/User' } },
          },
        },
      },
    };

    expect(findExternalRefs(spec, '')).toEqual([]);
  });

  it('finds refs nested inside allOf and array items too', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Wrapper: {
            allOf: [{ $ref: './schemas/base.yaml#/Base' }],
          },
          List: {
            type: 'array',
            items: { $ref: './schemas/item.yaml#/Item' },
          },
        },
      },
    };

    const refs = findExternalRefs(spec, '');
    const filePaths = refs.map((r) => r.filePath).sort();
    expect(filePaths).toEqual(['schemas/base.yaml', 'schemas/item.yaml']);
  });
});

describe('mergeExternalRefs', () => {
  it('4. splices the external document schema in under the synthesized name and rewrites the original $ref', () => {
    const spec: Record<string, unknown> = {
      paths: {
        '/users/{id}': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: './schemas/user.yaml#/User' },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: {} },
    };

    const resolved = new Map<string, Record<string, unknown>>([
      [
        'schemas/user.yaml',
        {
          components: {
            schemas: {
              User: {
                type: 'object',
                properties: { phoneNumber: { type: 'string' } },
              },
            },
          },
        },
      ],
    ]);

    const merged = mergeExternalRefs(spec, resolved);

    const components = merged.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(schemas['schemas/user.yaml#User']).toEqual({
      type: 'object',
      properties: { phoneNumber: { type: 'string' } },
    });

    const paths = merged.paths as Record<string, unknown>;
    const pathItem = paths['/users/{id}'] as Record<string, unknown>;
    const get = pathItem.get as Record<string, unknown>;
    const responses = get.responses as Record<string, unknown>;
    const response200 = responses['200'] as Record<string, unknown>;
    const content = response200.content as Record<string, unknown>;
    const mediaType = content['application/json'] as Record<string, unknown>;
    const schema = mediaType.schema as Record<string, unknown>;
    expect(schema.$ref).toBe('#/components/schemas/schemas/user.yaml#User');

    // Original input is not mutated (pure function).
    const origSchema = (
      (
        (
          (
            ((spec.paths as Record<string, unknown>)['/users/{id}'] as Record<string, unknown>)
              .get as Record<string, unknown>
          ).responses as Record<string, unknown>
        )['200'] as Record<string, unknown>
      ).content as Record<string, unknown>
    )['application/json'] as Record<string, unknown>;
    expect((origSchema.schema as Record<string, unknown>).$ref).toBe('./schemas/user.yaml#/User');
  });

  it('5. with an empty resolved map returns spec with all refs untouched (still opaque)', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Wrapper: {
            type: 'object',
            properties: { user: { $ref: './schemas/user.yaml#/User' } },
          },
        },
      },
    };

    const merged = mergeExternalRefs(spec, new Map());

    expect(merged).toEqual(spec);
  });

  it('leaves a ref untouched when its target is not present in the resolved map', () => {
    const spec: Record<string, unknown> = {
      components: {
        schemas: {
          Wrapper: {
            type: 'object',
            properties: { user: { $ref: './schemas/missing.yaml#/User' } },
          },
        },
      },
    };
    const resolved = new Map<string, Record<string, unknown>>([
      ['schemas/other.yaml', { components: { schemas: { Other: { type: 'object' } } } }],
    ]);

    const merged = mergeExternalRefs(spec, resolved);

    const components = merged.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    const wrapper = schemas.Wrapper as Record<string, unknown>;
    const properties = wrapper.properties as Record<string, unknown>;
    const user = properties.user as Record<string, unknown>;
    expect(user.$ref).toBe('./schemas/missing.yaml#/User');
    // The unrelated resolved entry is still spliced in.
    expect(schemas['schemas/other.yaml#Other']).toEqual({ type: 'object' });
  });
});
