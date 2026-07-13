# Spec L — Cross-File `$ref` Resolution

**Wave:** V1 | **Agent:** module-builder | **Depends on:** V0
**Files produced:** `src/lib/diff/resolveRefs.ts`, `src/lib/github/fetchExternalRefs.ts`,
`tests/diff/resolveRefs.test.ts`, `tests/github/fetchExternalRefs.test.ts`,
`tests/fixtures/multi-file-spec/` (new fixture directory)
**Touches no existing file.** Both output files are new; wiring into the pipeline is
Track P's job (Wave V2), not this track's.

## Purpose

Closes the v1 blind spot documented in `docs/PLAN_V2.md §1`: `flattenSchema.ts`'s
`typeDescriptor()` treats every `$ref` as an opaque label and never resolves it. That's
harmless for same-document refs to `#/components/schemas/X` (the top-level walk already
flattens `X` independently), but a `$ref` pointing at **another file in the same repo**
(e.g. `./schemas/user.yaml#/User`) is never fetched — fields deleted or mutated inside it
are invisible to the diff. This track makes those refs resolvable.

**Security boundary — read before writing any code:** only **repo-relative file paths**
are resolved. Absolute URL `$ref` values (`https://...`, `http://...`) are explicitly
**not** fetched — leave them exactly as `typeDescriptor` already renders them today
(opaque `ref:<name>` label). This is not a shortcut to fix later; it is a permanent
decision. The PR body / spec content that drives `$ref` resolution is fully
attacker-controlled input reaching a webhook-triggered backend process — resolving a
URL would be an SSRF vector (internal network / cloud-metadata endpoint access) and a
DoS lever (slow/huge remote response). File refs are safe because they resolve through
the same GitHub App installation credentials already scoped to the repo being scanned;
URL refs would need their own dedicated trust boundary and are out of scope for v2
(`docs/PLAN_V2.md §10`).

## File 1 — `src/lib/diff/resolveRefs.ts` (PURE — Law 2: no IO, no env, no logging)

```ts
/** A $ref string that points outside the current document (relative file path). */
export interface ExternalRef {
  /** The raw $ref string exactly as it appears in the spec. */
  raw: string;
  /** Repo-relative path to the target file, resolved against basePath. Forward slashes. */
  filePath: string;
  /** The #/fragment portion after the file path, or undefined if there is none. */
  fragment?: string;
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
): ExternalRef[];

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
 */
export function mergeExternalRefs(
  spec: Record<string, unknown>,
  resolved: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown>;
```

Implementation notes:
- Reuse the exact same walk shape as `flattenSchema.ts` (`components.schemas`,
  `paths[path][method].requestBody.content[*].schema`,
  `paths[path][method].responses[code].content[*].schema`, plus recursing into inline
  `properties`/`items`/`allOf` members) — a `$ref` can appear at any of those positions,
  not just inside `components.schemas`. Do not import from `flattenSchema.ts`; a small
  amount of duplicated walk logic here is correct (Law 2 — this module has a different
  purpose: collecting `$ref` locations, not typing fields) rather than coupling two pure
  modules that change independently.
- A ref string is a **relative file ref** iff it does not start with `#` and does not
  match `/^[a-z][a-z0-9+.-]*:\/\//i` (scheme prefix — catches `http://`, `https://`, and
  any other URI scheme, which must all be rejected per the security boundary above).
- `basePath` resolution: split on `/`, apply `.`/`..` segments against the directory
  portion of the referencing file's own path (same directory-relative semantics
  `require`/ES-module relative imports use) — no leading-`/` (repo-root-absolute) case
  needs special handling beyond "no `../` past the root," which `fetchExternalRefs`
  guards against separately (see File 2).
- Synthesized name collisions: if two different external files happen to produce the
  same synthesized name (impossible by construction since the name embeds the
  `filePath`), that's a bug — the tests should not need to check this, since
  `filePath#originalName` is unique by construction given `filePath` is already unique
  per source file.

## File 2 — `src/lib/github/fetchExternalRefs.ts` (IO — Spec E extension)

```ts
import type { Octokit } from 'octokit';

/**
 * Orchestrate: find this spec's external file refs, fetch each target via the Contents
 * API (Law 11's Contents exception already covers spec files — this stays inside that
 * exception, never switches to Blobs), parse each as an OpenAPI doc, recurse into
 * refs found INSIDE those documents up to maxDepth, then structurally merge everything
 * back into the root spec. Returns the root spec unchanged if there are no external
 * refs (zero extra API calls — same "don't do work you don't need" principle as
 * scanRepo.ts's targetFields.size === 0 short-circuit).
 */
export async function resolveSpecRefs(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    ref: string; // same ref/sha the root spec itself was fetched at
    rootSpec: Record<string, unknown>;
    rootPath: string; // e.g. link.openapi_file_path — used as basePath for the root walk
    maxDepth: number; // env.maxRefResolutionDepth
    concurrency: number; // env.scanConcurrency — reuse, do not invent a third concurrency knob
  },
): Promise<Record<string, unknown>>;
```

Algorithm:
1. `findExternalRefs(rootSpec, dirname(rootPath))` (dirname = everything before the
   last `/`, or `''` for a root-level file).
2. If empty → return `rootSpec` unchanged (short-circuit, zero fetches).
3. Fetch all found targets via `fetchFileText` (existing `contents.ts` export — do not
   add a second Contents-API wrapper), bounded by `mapWithConcurrency(targets,
   concurrency, ...)` (Law 9). A `FileNotFoundError` for one target does not abort the
   others — catch per-target, drop that ref from the resolved map (it stays
   unresolved/opaque, per `mergeExternalRefs`'s documented behavior), and continue.
4. Parse each fetched text with `parseOpenApiSpec` (existing `diff/parseSpec.ts` export).
   A `SpecParseError` on one target is handled the same as a fetch failure — dropped,
   not fatal to the others.
5. **Cycle + depth guard (this function's responsibility, not `mergeExternalRefs`'s):**
   maintain a `visited: Set<string>` of normalized file paths across the whole
   recursive resolution (seeded with `rootPath` itself). Before fetching a target,
   skip it if already in `visited` (breaks cycles) or if `currentDepth >= maxDepth`
   (bounds cost) — in both cases the ref is simply left unresolved, never thrown.
6. For each successfully parsed target, recurse: find further external refs inside
   *that* document (base path = the target's own directory), fetch/parse those too
   (depth + 1), merging results bottom-up.
7. `mergeExternalRefs(rootSpec, resolvedMap)` once, at the end, with the full
   (possibly multi-level) resolved map keyed by normalized file path.

Never throws past its own boundary for any per-target problem (network error aside from
"not found," malformed YAML, cycle, depth cap) — all degrade to "this ref stays
unresolved," consistent with Law 10's fail-open spirit applied at field granularity
rather than pipeline granularity. An error fetching the *root* spec itself is not this
function's concern (the pipeline already fetches the root spec before calling this).

## Acceptance tests

`tests/fixtures/multi-file-spec/`: `openapi.json` (root) with a `$ref:
"./schemas/user.yaml#/User"` inside a path's response schema, plus `schemas/user.yaml`
defining `User` with a `phoneNumber` field. Build two versions (base/head) mirroring the
existing single-file fixture pattern (check `tests/fixtures/` for the v1 precedent
before inventing a new layout).

`resolveRefs.test.ts` (pure, no network):
1. `findExternalRefs` finds a relative-path ref inside `paths[...].responses[...]`.
2. `findExternalRefs` does NOT return a `#/components/schemas/X` same-document ref.
3. `findExternalRefs` does NOT return an `https://...` ref (security boundary).
4. `mergeExternalRefs` splices the external document's schema in under the synthesized
   name and rewrites the original `$ref` to point at it.
5. `mergeExternalRefs` with an empty `resolved` map returns `spec` with all refs
   untouched (still opaque).

`fetchExternalRefs.test.ts` (fake Octokit, no network — mirror `tests/fixtures`/fake
patterns already used for `contents.ts`/`scanRepo.ts` tests):
1. Zero external refs → `resolveSpecRefs` returns the input unchanged, zero
   `octokit.request` calls.
2. One external ref, successfully fetched → returned spec has the field flattened
   from the external schema (integration-level check: run the result through
   `flattenOpenApiFields` and assert the external field is present).
3. Target 404s (`FileNotFoundError`) → ref stays unresolved, no throw.
4. Cyclic refs (`a.yaml` → `b.yaml` → `a.yaml`) → resolves without hanging or
   stack-overflowing; both documents fetched at most once each.
5. Chain deeper than `maxDepth` → refs beyond the cap stay unresolved; no throw.
6. Bounded concurrency: with N external refs and `concurrency: 2`, no more than 2
   `octokit.request` calls are in flight at once (reuse the same assertion pattern
   `scanRepo.test.ts` already uses for `mapWithConcurrency`, if present — check before
   inventing a new one).

## Forbidden

- Fetching or resolving any `$ref` that is an absolute URL — this is a hard security
  boundary, not a v1-parity gap to close later (see Purpose section above).
- Sequential `await` in a loop over multiple ref targets, or an unbounded
  `Promise.all` (Law 9 — must route through `mapWithConcurrency`).
- Any import of Octokit, `fetch`, or env into `resolveRefs.ts` (Law 2 — that file is
  pure; all IO lives in `fetchExternalRefs.ts`).
- Modifying `flattenSchema.ts` or `diffSchemas.ts` — this track's output is consumed by
  Track P's pipeline wiring, not by editing the existing diff files.
