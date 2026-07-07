// Spec B, File 2 — flatten an OpenAPI v3 object into Map<"parent.field", FieldRecord>.
// PURE (Law 2): no IO, no env, no logging.
// Hand-rolled walk only — NO OpenAPI parsing library (Forbidden list).

/** A single flattened schema property: its owning parent path, name, and canonical type. */
export interface FieldRecord {
  parent: string;
  field: string;
  type: string;
}

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'options',
  'head',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastSlashSegment(ref: string): string {
  const idx = ref.lastIndexOf('/');
  return idx === -1 ? ref : ref.slice(idx + 1);
}

/** Canonical type string for a property schema `s` (spec §File 2 typeDescriptor). */
function typeDescriptor(s: unknown): string {
  // 1. Not an object / null → 'unknown'.
  if (!isObject(s)) return 'unknown';

  // 2. Has $ref (string) → 'ref:' + lastSlashSegment(ref).
  if (typeof s.$ref === 'string') {
    return 'ref:' + lastSlashSegment(s.$ref);
  }

  // 3. type === 'array' → `array<${typeDescriptor(s.items ?? {})}>`.
  if (s.type === 'array') {
    return `array<${typeDescriptor(s.items ?? {})}>`;
  }

  // 4. Has enum (array) → `enum(${s.type ?? 'string'})`.
  if (Array.isArray(s.enum)) {
    return `enum(${typeof s.type === 'string' ? s.type : 'string'})`;
  }

  // 5. Has type (string) → format ? `${type}(${format})` : type.
  if (typeof s.type === 'string') {
    return typeof s.format === 'string' ? `${s.type}(${s.format})` : s.type;
  }

  // 6. Has properties → 'object'.
  if (isObject(s.properties)) return 'object';

  // 7. Otherwise → 'unknown'.
  return 'unknown';
}

/** Flatten an OpenAPI v3 object into Map<"parent.field", FieldRecord>. */
export function flattenOpenApiFields(
  spec: Record<string, unknown>,
): Map<string, FieldRecord> {
  const out = new Map<string, FieldRecord>();

  function record(parent: string, field: string, type: string): void {
    out.set(parent + '.' + field, { parent, field, type });
  }

  function walkObjectSchema(parent: string, schema: unknown, depth: number): void {
    // 1. Guards.
    if (depth > 10) return;
    if (!isObject(schema)) return;
    if (typeof schema.$ref === 'string') return;

    // 2. allOf: recurse into inline (non-$ref) members only.
    if (Array.isArray(schema.allOf)) {
      for (const element of schema.allOf) {
        if (isObject(element) && typeof element.$ref === 'string') continue;
        walkObjectSchema(parent, element, depth);
      }
    }

    // 3. properties.
    if (isObject(schema.properties)) {
      for (const [field, propSchema] of Object.entries(schema.properties)) {
        // a. record with canonical type.
        record(parent, field, typeDescriptor(propSchema));

        // b. inline object (no $ref, has properties) → recurse.
        if (
          isObject(propSchema) &&
          typeof propSchema.$ref !== 'string' &&
          isObject(propSchema.properties)
        ) {
          walkObjectSchema(parent + '.' + field, propSchema, depth + 1);
        }

        // c. array whose items is an inline object with properties → recurse under [].
        if (
          isObject(propSchema) &&
          propSchema.type === 'array' &&
          isObject(propSchema.items) &&
          typeof propSchema.items.$ref !== 'string' &&
          isObject(propSchema.items.properties)
        ) {
          walkObjectSchema(parent + '.' + field + '[]', propSchema.items, depth + 1);
        }
      }
    }

    // 4. Top-level array body.
    if (schema.type === 'array' && schema.items !== undefined) {
      walkObjectSchema(parent + '[]', schema.items, depth);
    }
  }

  // Main flow.

  // 1. components.schemas.
  const components = spec.components;
  if (isObject(components) && isObject(components.schemas)) {
    for (const [name, schema] of Object.entries(components.schemas)) {
      walkObjectSchema(name, schema, 0);
    }
  }

  // 2. paths.
  const paths = spec.paths;
  if (isObject(paths)) {
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!isObject(pathItem)) continue;

      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!isObject(operation)) continue;

        const opId = method.toUpperCase() + ' ' + path;

        // requestBody.content media types with an inline (.schema, no $ref).
        const requestBody = operation.requestBody;
        if (isObject(requestBody) && isObject(requestBody.content)) {
          for (const mediaType of Object.values(requestBody.content)) {
            if (!isObject(mediaType)) continue;
            const schema = mediaType.schema;
            if (isObject(schema) && typeof schema.$ref !== 'string') {
              walkObjectSchema(opId + ' request', schema, 0);
            }
          }
        }

        // responses[statusCode].content media types with an inline (.schema, no $ref).
        const responses = operation.responses;
        if (isObject(responses)) {
          for (const [statusCode, response] of Object.entries(responses)) {
            if (!isObject(response) || !isObject(response.content)) continue;
            for (const mediaType of Object.values(response.content)) {
              if (!isObject(mediaType)) continue;
              const schema = mediaType.schema;
              if (isObject(schema) && typeof schema.$ref !== 'string') {
                walkObjectSchema(opId + ' response ' + statusCode, schema, 0);
              }
            }
          }
        }
      }
    }
  }

  return out;
}
