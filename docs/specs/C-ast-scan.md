# Spec C — AST Scanning Engine + Bounded Concurrency

**Wave:** 1 | **Agent:** ast-specialist | **Depends on:** W0
**Files produced:**
1. `src/lib/scan/concurrency.ts`
2. `src/lib/scan/astScanner.ts`
Tests: `tests/scan/concurrency.test.ts`, `tests/scan/astScanner.test.ts`.

Both files are PURE (Law 2): no IO, no env, no Octokit, no logging.

---

## File 1 — concurrency.ts

SRD §3 "API Timeout Windows": bounded execution worker for concurrent fetching.

```ts
/**
 * Run `worker` over `items` with at most `limit` concurrent executions.
 * Results preserve input order. Rejects with the FIRST worker error (callers that
 * need per-item resilience wrap their worker in try/catch themselves).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]>;
```

### Implementation (shared-cursor pattern — follow exactly)
1. Validate: `limit` not a positive finite integer → throw `new Error('limit must be a positive integer')`.
2. `items.length === 0` → return `[]` without invoking worker.
3. `const results = new Array<R>(items.length); let cursor = 0;`
4. `runner = async () => { while (true) { const i = cursor++; if (i >= items.length) return; results[i] = await worker(items[i]!, i); } }`
5. `await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));`
6. Return `results`.

No queues, no events, no external libs. This exact pattern is ~15 lines.

### Acceptance tests (concurrency)
1. Order preserved: workers with REVERSED delays (item 0 slowest) still return `[r0, r1, r2, ...]`.
2. Concurrency cap: instrument a counter (`active++` / `active--` around an awaited
   timer); with limit 3 over 10 items, max observed `active` === 3.
3. limit larger than items.length works (5 items, limit 50).
4. Worker rejection propagates (await expect(...).rejects) and does not hang.
5. limit 0 / -1 / 2.5 → throws.
6. Empty items → `[]`, worker never called.

---

## File 2 — astScanner.ts

SRD Module 4: parse source text with the native `typescript` compiler library into Node
objects — NO regular expressions (Law 7).

```ts
import type { UsageMatch } from '@/types/contract';
export function scanSourceForFields(opts: {
  /** Repo-relative path, forward slashes — used for ScriptKind detection and output. */
  filePath: string;
  sourceText: string;
  targetFields: ReadonlySet<string>;
}): UsageMatch[];
```

### Setup
```ts
import ts from 'typescript';
```
- ScriptKind from extension: `.tsx` → `ts.ScriptKind.TSX`, `.jsx` → `ts.ScriptKind.JSX`,
  `.js` → `ts.ScriptKind.JS`, everything else → `ts.ScriptKind.TS`.
- `const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);`
- Pre-split `sourceText.split(/\r?\n/)` ONCE for snippets (this split is not "scanning" —
  Law 7 applies to field detection).
- If `targetFields.size === 0` → return `[]` immediately (skip parsing).

### Visitor — recursive `ts.forEachChild(node, visit)` from `sf`.

**Checkpoint 1 — Direct Property Access (`ts.isPropertyAccessExpression(node)`):**
SRD: catch `response.data.phoneNumber`.
- `const name = node.name;` — if `ts.isIdentifier(name)` and `targetFields.has(name.text)`
  → record a match with `kind: 'property-access'`, positioned at `name.getStart(sf)`.
- PrivateIdentifiers (`obj.#x`) are excluded by the isIdentifier guard — correct, skip them.
- Optional chaining `user?.phoneNumber` is still a PropertyAccessExpression → caught
  automatically; add a test proving it.

**Checkpoint 2 — Object Destructuring (`ts.isBindingElement(node)`):**
SRD: catch `const { phoneNumber } = userData`. THE ALIAS TRAP (SRD §3, Law 6): for
`const { phoneNumber: phone } = user` you MUST evaluate the source property key
(`phoneNumber`), never the alias (`phone`).
Decision table — derive `sourceKey: string | null`:

| Shape | node.propertyName | node.name | sourceKey |
|---|---|---|---|
| `{ phoneNumber }` | undefined | Identifier | `name.text` |
| `{ phoneNumber: phone }` | Identifier | Identifier | `propertyName.text` (NEVER name) |
| `{ "phoneNumber": p }` | StringLiteral | any | `propertyName.text` |
| `{ [expr]: p }` | ComputedPropertyName | any | `null` — skip (dynamic) |
| `{ ...rest }` | — (`dotDotDotToken` set) | any | `null` — skip |
| `const [a, b] = arr` | — | — | `null` — parent is ArrayBindingPattern, skip |

Guards, in order:
1. `if (!ts.isObjectBindingPattern(node.parent)) → skip` (kills array-binding case).
2. `if (node.dotDotDotToken) → skip`.
3. `if (node.propertyName)`: Identifier → `.text`; StringLiteral → `.text`;
   NumericLiteral → `.text`; ComputedPropertyName → skip.
4. else: `ts.isIdentifier(node.name)` → `name.text`; otherwise skip (nested pattern with
   no propertyName cannot name a key we track).
- If `sourceKey && targetFields.has(sourceKey)` → record with `kind: 'destructuring'`,
  positioned at `(node.propertyName ?? node.name).getStart(sf)`.
- NOTE: nested destructuring `const { user: { phoneNumber } } = resp` produces a
  BindingElement for the inner `phoneNumber` whose parent IS an ObjectBindingPattern →
  caught naturally. The OUTER element (`user:` with a pattern as name) hits guard 4's
  "otherwise skip" unless `user` itself is a target — in which case propertyName/name
  logic records `user`. This is correct; do not special-case.

**Position & snippet (both checkpoints):**
```ts
const { line, character } = sf.getLineAndCharacterOfPosition(posNode.getStart(sf));
// UsageMatch: line: line + 1, column: character + 1  (Law 14: 1-based)
// snippet: (lines[line] ?? '').trim().slice(0, 200)
```

**Dedupe:** key = `${field}|${line}|${column}|${kind}`; keep first occurrence.
**Parser resilience:** `createSourceFile` never throws on bad syntax (it produces a
best-effort tree) — do NOT wrap in try/catch that hides real bugs.

### Acceptance tests (astScanner) — targets: `phoneNumber`, `age`
Author one fixture string per case inside the test file:
1. `resp.data.phoneNumber` → 1 match, property-access, correct 1-based line/column, snippet.
2. `const { phoneNumber } = userData;` → 1 match, destructuring.
3. **Alias law:** `const { phoneNumber: phone } = user;` → exactly 1 match with
   `field === 'phoneNumber'`; and scanning with targets `{'phone'}` → 0 matches.
4. String-literal key: `const { "phoneNumber": p } = u;` → 1 match.
5. Computed: `const { [key]: v } = u;` with targets containing `key` → 0 matches.
6. Rest: `const { ...rest } = u;` with targets `{'rest'}` → 0 matches.
7. Array binding: `const [age] = rows;` → 0 matches (age is positional, not a key).
8. Optional chain: `user?.phoneNumber` → 1 property-access match.
9. TSX: `<span>{user.phoneNumber}</span>` parsed as `.tsx` → 1 match; the same text as
   `.ts` must not crash (result may differ — assert no throw only).
10. Multi-hit line `a.age + b.age` → 2 matches, different columns.
11. Irrelevant source (`const x = 1;`) → `[]`.
12. Nested destructure `const { user: { phoneNumber } } = resp;` → 1 match for phoneNumber.
13. Syntactically broken file (`const { = ;`) → returns without throwing.
14. Writing an object literal `{ phoneNumber: value }` (ShorthandPropertyAssignment /
    PropertyAssignment) is NOT one of the two SRD checkpoints → 0 matches. Document this
    with a comment in the test.

## Forbidden
- Regex/string-includes matching of identifiers (Law 7).
- `ts.createProgram` / type checker / language service (text-level parse only — no
  type resolution is needed and it would explode memory in serverless).
- Matching `ElementAccessExpression` (`u["phoneNumber"]`) — out of scope v1 (PLAN §7);
  leave a `// extension point:` comment where it would go.
