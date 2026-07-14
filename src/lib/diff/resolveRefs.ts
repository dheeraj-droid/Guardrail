// Spec L, File 1 — cross-file $ref discovery + structural merge.
// PURE (Law 2): no IO, no env, no logging, no Octokit, no fetch.
// Hand-rolled walk only (mirrors flattenSchema.ts's shape without importing it — Law 2
// keeps these two pure modules decoupled since they change for different reasons).

/** A $ref string that points outside the current document (relative file path). */
export interface ExternalRef {
  /** The raw $ref string exactly as it appears in the spec. */
  raw: string;
  /** Repo-relative path to the target file, resolved against basePath. Forward slashes. */
  filePath: string;
  /** The #/fragment portion after the file path, or undefined if there is none. */
  fragment?: string;
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

/** Absolute-URL scheme prefix (http://, https://, or any other URI scheme). */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Guards against pathological self-referential (e.g. YAML-anchor) object cycles. */
const MAX_WALK_DEPTH = 50;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A ref string is a relative file ref iff it does NOT start with `#` (same-document
 * fragment) and does NOT look like an absolute URL (any `scheme://` prefix). Security
 * boundary (see spec Purpose section): absolute URLs are never treated as file refs.
 */
function isRelativeFileRef(ref: string): boolean {
  if (ref.startsWith('#')) return false;
  if (SCHEME_RE.test(ref)) return false;
  return true;
}

/** Split a $ref string into its file portion and (optional) fragment portion. */
function splitRef(ref: string): { filePart: string; fragment?: string } {
  const idx = ref.indexOf('#');
  if (idx === -1) return { filePart: ref };
  return { filePart: ref.slice(0, idx), fragment: ref.slice(idx + 1) };
}

/**
 * POSIX-style relative path resolution (`.`/`..` segments) against `basePath` — no
 * `path` module (Law 13 minimalism; the rest of diff/ hand-rolls path-ish helpers too,
 * e.g. flattenSchema.ts's lastSlashSegment). `..` past the root is simply absorbed
 * (never throws); fetchExternalRefs guards bounds separately on the IO side.
 */
function resolveRelativePath(basePath: string, relativePath: string): string {
  const stack = basePath === '' ? [] : basePath.split('/');
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

/** Last non-empty `/`-separated segment of a fragment, e.g. '/User' -> 'User'. */
function lastFragmentSegment(fragment: string | undefined): string | undefined {
  if (!fragment) return undefined;
  const segments = fragment.split('/').filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

function hasSchema(doc: Record<string, unknown>, name: string): boolean {
  const components = doc.components;
  return isObject(components) && isObject(components.schemas) && name in components.schemas;
}

/**
 * Walk `spec` (same recursive shape flattenSchema.ts already walks: components.schemas
 * and paths[..][method].requestBody/responses) and collect every `$ref` string that is
 * a relative file reference — i.e. NOT starting with `#` (same-document) and NOT an
 * absolute URL (starts with a scheme like `http://`/`https://`). Resolve each target
 * path against `basePath` (POSIX-style relative resolution: `../`, `./` supported, no
 * `path` module — hand-roll the same way the rest of diff/ avoids new deps).
 */
export function findExternalRefs(
  spec: Record<string, unknown>,
  basePath: string,
): ExternalRef[] {
  const refs: ExternalRef[] = [];

  function visitSchema(schema: unknown, depth: number): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (!isObject(schema)) return;

    if (typeof schema.$ref === 'string') {
      const raw = schema.$ref;
      if (isRelativeFileRef(raw)) {
        const { filePart, fragment } = splitRef(raw);
        const filePath = resolveRelativePath(basePath, filePart);
        refs.push({ raw, filePath, ...(fragment !== undefined ? { fragment } : {}) });
      }
      // $ref replaces the entire schema — sibling keys are ignored per OpenAPI semantics.
      return;
    }

    if (schema.type === 'array' && schema.items !== undefined) {
      visitSchema(schema.items, depth + 1);
    }

    if (isObject(schema.properties)) {
      for (const propSchema of Object.values(schema.properties)) {
        visitSchema(propSchema, depth + 1);
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        visitSchema(member, depth + 1);
      }
    }
  }

  // 1. components.schemas.
  const components = spec.components;
  if (isObject(components) && isObject(components.schemas)) {
    for (const schema of Object.values(components.schemas)) {
      visitSchema(schema, 0);
    }
  }

  // 2. paths[path][method].requestBody/responses.
  const paths = spec.paths;
  if (isObject(paths)) {
    for (const pathItem of Object.values(paths)) {
      if (!isObject(pathItem)) continue;

      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!isObject(operation)) continue;

        const requestBody = operation.requestBody;
        if (isObject(requestBody) && isObject(requestBody.content)) {
          for (const mediaType of Object.values(requestBody.content)) {
            if (isObject(mediaType)) visitSchema(mediaType.schema, 0);
          }
        }

        const responses = operation.responses;
        if (isObject(responses)) {
          for (const response of Object.values(responses)) {
            if (!isObject(response) || !isObject(response.content)) continue;
            for (const mediaType of Object.values(response.content)) {
              if (isObject(mediaType)) visitSchema(mediaType.schema, 0);
            }
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Structural merge: for every entry in `resolved` (keyed by the SAME normalized
 * filePath findExternalRefs produced), splice that document's `components.schemas`
 * entries into `spec`'s own `components.schemas` under synthesized names
 * `"<filePath>#<originalSchemaName>"`, and rewrite every `$ref` in `spec` that pointed
 * at that file to the synthesized local name (so flattenSchema.ts, unmodified, walks
 * the merged result exactly as it walks any other same-document schema). Refs not
 * present in `resolved` (unresolvable / depth-exceeded / cyclic) are left untouched —
 * they keep rendering as today's opaque `ref:<name>` label, never thrown.
 *
 * Cycle safety: `resolved` is caller-built (fetchExternalRefs owns the depth/cycle
 * guard), so this function does not recurse — it is a single flat splice pass. Pure
 * functions must not loop on their own input; recursion depth is fetchExternalRefs's
 * concern (IO side), not this one's.
 *
 * Rewrite matching is basePath-relative to the document root (`spec` itself) — the
 * function this is documented to be called on once, at the end, with `spec` being the
 * root spec (see fetchExternalRefs.ts). Splicing (the part the diff actually depends
 * on — flattenSchema.ts's own top-level components.schemas walk discovers the spliced
 * entries independently of any $ref rewrite) always happens for every resolved entry
 * regardless of whether a matching raw $ref is found to rewrite.
 */
export function mergeExternalRefs(
  spec: Record<string, unknown>,
  resolved: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (resolved.size === 0) return spec;

  const cloned = structuredClone(spec);

  const components = isObject(cloned.components)
    ? cloned.components
    : (cloned.components = {} as Record<string, unknown>);
  const schemas = isObject(components.schemas)
    ? (components.schemas as Record<string, unknown>)
    : (components.schemas = {} as Record<string, unknown>);

  for (const [filePath, doc] of resolved) {
    const docComponents = doc.components;
    if (isObject(docComponents) && isObject(docComponents.schemas)) {
      for (const [name, schemaDef] of Object.entries(docComponents.schemas)) {
        // Clone the spliced-in definition too — `doc` is caller-owned (part of
        // `resolved`); mutating it via the rewrite pass below would be an
        // observable side effect on shared state, which a pure function must avoid.
        schemas[`${filePath}#${name}`] = structuredClone(schemaDef);
      }
    }
  }

  rewriteRefs(cloned, resolved);

  return cloned;
}

function rewriteRefs(
  node: unknown,
  resolved: ReadonlyMap<string, Record<string, unknown>>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefs(item, resolved);
    return;
  }
  if (!isObject(node)) return;

  if (typeof node.$ref === 'string') {
    const raw = node.$ref;
    if (isRelativeFileRef(raw)) {
      const { filePart, fragment } = splitRef(raw);
      const filePath = resolveRelativePath('', filePart);
      const doc = resolved.get(filePath);
      const schemaName = lastFragmentSegment(fragment);
      if (doc && schemaName && hasSchema(doc, schemaName)) {
        node.$ref = `#/components/schemas/${filePath}#${schemaName}`;
      }
    }
    // A $ref node has no other meaningful keys to rewrite into.
    return;
  }

  for (const value of Object.values(node)) {
    rewriteRefs(value, resolved);
  }
}
