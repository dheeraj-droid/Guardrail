// Spec C, File 2 — AST scanning engine (SRD Module 4).
// PURE (Law 2): no IO, no env, no Octokit, no logging.
// Law 7: field-usage detection uses the `typescript` compiler API ONLY. No regex, no
// string-includes matching of identifiers. (The one `.split(/\r?\n/)` below is snippet
// slicing, not detection, so it is permitted.)
// Law 14: emitted line/column are 1-based.

import ts from 'typescript';
import type { UsageMatch } from '@/types/contract';

/** Pick the ScriptKind from the file extension so JSX/TSX parse correctly. */
function scriptKindFromPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Parse `sourceText` with the native TypeScript compiler and return every reference to a
 * field in `targetFields`, via two checkpoints only:
 *   1. PropertyAccessExpression  — `response.data.phoneNumber`, `user?.phoneNumber`
 *   2. BindingElement (object destructuring) — `const { phoneNumber } = u`
 * The destructuring alias trap (Law 6): match the SOURCE property key, never the local alias.
 */
export function scanSourceForFields(opts: {
  /** Repo-relative path, forward slashes — used for ScriptKind detection and output. */
  filePath: string;
  sourceText: string;
  targetFields: ReadonlySet<string>;
}): UsageMatch[] {
  const { filePath, sourceText, targetFields } = opts;

  // No targets → nothing can match; skip parsing entirely.
  if (targetFields.size === 0) return [];

  const scriptKind = scriptKindFromPath(filePath);
  // setParentNodes:true is REQUIRED — the binding-pattern guard reads node.parent.
  // createSourceFile never throws on bad syntax (best-effort tree), so no try/catch here:
  // wrapping it would hide real bugs (spec "Parser resilience").
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind,
  );

  // Pre-split once for snippet extraction. This is line slicing, not field detection (Law 7).
  const lines = sourceText.split(/\r?\n/);

  const matches: UsageMatch[] = [];
  const seen = new Set<string>(); // dedupe key: `${field}|${line}|${column}|${kind}`

  const record = (
    field: string,
    kind: UsageMatch['kind'],
    posNode: ts.Node,
  ): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(
      posNode.getStart(sf),
    );
    // getLineAndCharacterOfPosition is 0-based; emit 1-based (Law 14).
    const oneBasedLine = line + 1;
    const oneBasedColumn = character + 1;

    const dedupeKey = `${field}|${oneBasedLine}|${oneBasedColumn}|${kind}`;
    if (seen.has(dedupeKey)) return; // keep first occurrence only
    seen.add(dedupeKey);

    const snippet = (lines[line] ?? '').trim().slice(0, 200);

    matches.push({
      field,
      filePath,
      line: oneBasedLine,
      column: oneBasedColumn,
      kind,
      snippet,
    });
  };

  const visit = (node: ts.Node): void => {
    // --- Checkpoint 1: Direct Property Access (e.g. `response.data.phoneNumber`) ---
    // Optional chaining `user?.phoneNumber` is also a PropertyAccessExpression → caught here.
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name;
      // PrivateIdentifiers (`obj.#x`) fail this guard and are correctly skipped.
      if (ts.isIdentifier(name) && targetFields.has(name.text)) {
        record(name.text, 'property-access', name);
      }
      // extension point: ElementAccessExpression (`u["phoneNumber"]`) is out of scope for
      // v1 (PLAN §7). If added, handle it here by reading a StringLiteral argumentExpression.
    }

    // --- Checkpoint 2: Object Destructuring (e.g. `const { phoneNumber } = u`) ---
    else if (ts.isBindingElement(node)) {
      const sourceKey = destructuringSourceKey(node);
      if (sourceKey !== null && targetFields.has(sourceKey)) {
        // Position at the source key: propertyName if the shape is `{ key: alias }`,
        // else the name (the shorthand `{ key }` case).
        const posNode = node.propertyName ?? node.name;
        record(sourceKey, 'destructuring', posNode);
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  return matches;
}

/**
 * Derive the SOURCE property key a BindingElement reads, or `null` if it names no static
 * key we can track. Implements the spec's decision table (Law 6 — never the alias).
 */
function destructuringSourceKey(node: ts.BindingElement): string | null {
  // Guard 1: parent must be an object binding pattern. This kills the array-binding case
  // `const [age] = rows` (parent is an ArrayBindingPattern; `age` is positional, not a key).
  if (!ts.isObjectBindingPattern(node.parent)) return null;

  // Guard 2: rest element `{ ...rest }` binds the remainder, not a named key → skip.
  if (node.dotDotDotToken) return null;

  // Guard 3: `{ key: alias }` / `{ "key": alias }` / `{ [expr]: alias }` — propertyName is
  // the SOURCE key. Take it and NEVER look at node.name (the alias).
  if (node.propertyName) {
    const propertyName = node.propertyName;
    if (ts.isIdentifier(propertyName)) return propertyName.text;
    if (ts.isStringLiteral(propertyName)) return propertyName.text;
    if (ts.isNumericLiteral(propertyName)) return propertyName.text;
    // ComputedPropertyName `{ [expr]: p }` is dynamic → not statically trackable.
    return null;
  }

  // Guard 4: shorthand `{ key }` — the name IS the source key. If name is itself a binding
  // pattern (nested with no propertyName) it cannot name a key we track → skip. The inner
  // element of a nested destructure is visited separately, so nothing is lost.
  if (ts.isIdentifier(node.name)) return node.name.text;
  return null;
}
