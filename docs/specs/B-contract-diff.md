# Spec B — Contract Diffing (parse → flatten → diff)

**Wave:** 1 | **Agent:** module-builder | **Depends on:** W0
**Files produced (implement in this order):**
1. `src/lib/diff/parseSpec.ts`
2. `src/lib/diff/flattenSchema.ts`
3. `src/lib/diff/diffSchemas.ts`
Tests: `tests/diff/parseSpec.test.ts`, `tests/diff/flattenSchema.test.ts`,
`tests/diff/diffSchemas.test.ts`, fixtures in `tests/fixtures/openapi/`.

## Purpose
SRD Module 2: recursively walk nested JSON/YAML blocks of an OpenAPI v3 spec (paths +
components) and emit `BreakingChange[]` for DELETED and TYPE_MUTATED fields.
All three files are PURE (Law 2): no IO, no env, no logging.

---

## File 1 — parseSpec.ts

```ts
export class SpecParseError extends Error {
  constructor(message: string, readonly filePath: string, readonly cause?: unknown);
}
/** Parse raw OpenAPI text (JSON or YAML) into a plain object. */
export function parseOpenApiSpec(raw: string, filePath: string): Record<string, unknown>;
```
Rules:
- Extension `.json` → `JSON.parse`. `.yaml`/`.yml` → `YAML.parse` (from `yaml` package).
- Any other extension: try JSON first, on failure try YAML.
- If the parsed result is not a non-null object (e.g. a bare string/number/array) →
  throw `SpecParseError('Spec root is not an object', filePath)`.
- Wrap underlying parser errors in `SpecParseError` with the original as `cause`.
- Empty/whitespace-only `raw` → `SpecParseError('Spec file is empty', filePath)`.

## File 2 — flattenSchema.ts

```ts
export interface FieldRecord { parent: string; field: string; type: string }
/** Flatten an OpenAPI v3 object into Map<"parent.field", FieldRecord>. */
export function flattenOpenApiFields(spec: Record<string, unknown>): Map<string, FieldRecord>;
```

### Algorithm (follow exactly)
Maintain `out: Map<string, FieldRecord>`; helper `record(parent, field, type)` sets
`out.set(parent + '.' + field, { parent, field, type })`.

**typeDescriptor(s): string** — canonical type string for a property schema `s`:
1. Not an object / null → `'unknown'`.
2. Has `$ref` (string) → `'ref:' + lastSlashSegment(ref)` (e.g. `#/components/schemas/User` → `ref:User`).
3. `type === 'array'` → `` `array<${typeDescriptor(s.items ?? {})}>` ``.
4. Has `enum` (array) → `` `enum(${s.type ?? 'string'})` ``.
5. Has `type` (string) → `s.format ? \`${s.type}(${s.format})\` : s.type` (e.g. `integer(int64)`).
6. Has `properties` → `'object'`. 7. Otherwise → `'unknown'`.

**walkObjectSchema(parent: string, schema: unknown, depth: number): void**
1. Guard: `depth > 10` → return. Non-object/null schema → return. Schema with `$ref` → return
   (referenced schemas are walked under their own component name — prevents cycles AND
   duplicate records).
2. If `schema.allOf` is an array: for each element that does NOT have `$ref`, recurse
   `walkObjectSchema(parent, element, depth)` ($ref members are recorded under their own name).
3. If `schema.properties` is an object: for each `[field, propSchema]`:
   a. `record(parent, field, typeDescriptor(propSchema))`.
   b. If `propSchema` is an inline object (no `$ref`, and has `properties`) →
      `walkObjectSchema(parent + '.' + field, propSchema, depth + 1)`.
   c. If `propSchema.type === 'array'` and `propSchema.items` is an inline object with
      `properties` → `walkObjectSchema(parent + '.' + field + '[]', propSchema.items, depth + 1)`.
4. If `schema.type === 'array'` and `schema.items` exists →
   `walkObjectSchema(parent + '[]', schema.items, depth)` (top-level array bodies).

**Main flow:**
1. `components.schemas`: for each `[name, schema]` → `walkObjectSchema(name, schema, 0)`.
2. `paths`: for each `[path, pathItem]`, for each method of
   `['get','put','post','delete','patch','options','head']` present on pathItem:
   - Let `opId = method.toUpperCase() + ' ' + path` (e.g. `POST /users`).
   - `operation.requestBody.content`: for each media type entry with a `.schema` that has
     NO `$ref` → `walkObjectSchema(opId + ' request', schema, 0)`.
   - `operation.responses`: for each `[statusCode, response]`, each `response.content`
     media type `.schema` with NO `$ref` → `walkObjectSchema(opId + ' response ' + statusCode, schema, 0)`.
   ($ref'd bodies are already covered via components.)
3. Every read of a nested key must tolerate absence (optional chaining + type guards).
   Malformed fragments are SKIPPED silently, never thrown.

## File 3 — diffSchemas.ts

```ts
import type { BreakingChange } from '@/types/contract';
export function diffOpenApiSchemas(
  oldSpec: Record<string, unknown>,
  newSpec: Record<string, unknown>,
): BreakingChange[];
```
Rules:
1. Flatten both. For each `[key, oldRec]` of the OLD map:
   - Key absent in new map → `{ field: oldRec.field, parent: oldRec.parent, change: 'DELETED' }`.
   - Present but `type` string differs → `{ field, parent, change: 'TYPE_MUTATED',
     original: oldRec.type, updated: newRec.type }`.
2. Keys only in the NEW map (additions) are ignored — additions are non-breaking.
3. Sort deterministically: by `parent` asc, then `field` asc (plain `<` compare).
4. DELETED entries must NOT carry `original`/`updated` keys at all.

## Acceptance tests
Fixtures (author these): `tests/fixtures/openapi/user-v1.json` — components.schemas.User
with `phoneNumber: string`, `age: integer`, `email: string`, nested `address` object with
`street: string`, and a `POST /users` requestBody with inline schema field `nickname: string`.
`user-v2.json` — same but: `phoneNumber` REMOVED, `age` type `string`, `street` REMOVED,
`nickname` type `integer`, plus an ADDED field `middleName`. Also `user-v1.yaml` — YAML
translation of user-v1.json.

1. parse: JSON fixture parses; YAML fixture parses; both produce equal flatten maps.
2. parse: `.txt` raw containing YAML parses via fallback; garbage text → SpecParseError;
   empty string → SpecParseError; root `"hello"` → SpecParseError.
3. flatten: v1 map contains keys `User.phoneNumber`, `User.age` (`integer`),
   `User.address` (`object`), `User.address.street`, `POST /users request.nickname`.
4. flatten: self-referencing schema (`Node.children: array<ref:Node>`) terminates and
   records `Node.children` as `array<ref:Node>`.
5. diff v1→v2 returns EXACTLY (order matters):
   - `POST /users request.nickname` TYPE_MUTATED string→integer
   - `User.address.street` DELETED
   - `User.age` TYPE_MUTATED integer(?)→string (match your descriptor format)
   - `User.phoneNumber` DELETED
   and does NOT contain `middleName`.
6. diff identical specs → `[]`.
7. TYPE_MUTATED via format change: `integer` → `integer(int64)` IS a mutation (descriptor differs).

## Forbidden
- Any OpenAPI parsing library (`swagger-parser`, `openapi-types`, ...). Hand-rolled walk only.
- Resolving `$ref` to external files/URLs. Local behavior is defined above.
- Throwing on malformed spec FRAGMENTS (only root-level parse failures throw, in parseSpec).
