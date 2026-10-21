import type TS from "typescript";

/**
 * The TypeScript compiler, used as a parser only (ADR-0007). It is about 3.5 MB, so it is
 * loaded on the first scan instead of when the extension starts. Every scanner module
 * imports this binding; it is set once `loadTypeScript()` has resolved.
 */
export let ts = undefined as unknown as typeof TS;

export async function loadTypeScript(): Promise<typeof TS> {
  ts ??= (await import("typescript")).default;
  return ts;
}

/** The parser setting for a file name, by extension. */
export function scriptKindOf(fileName: string): TS.ScriptKind {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/** Text of a string literal or a template literal without `${}`; otherwise `undefined`. */
export function stringValue(node: TS.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return stringValue(node.expression);
  return undefined;
}

/** Strip `(x)`, `x as T`, `x satisfies T`, `x!` and `<T>x` to get the expression underneath. */
export function unwrap(node: TS.Expression): TS.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/** Name of a property access (`a.b` → `b`) or a string-keyed element access (`a["b"]`). */
export function memberName(node: TS.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return stringValue(node.argumentExpression);
  return undefined;
}

/** Name of a property in an object literal or a binding pattern, when it is static. */
export function propertyNameText(name: TS.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return stringValue(name.expression);
  return undefined;
}

/** Visit every node under `node` (depth first). Return `false` from `visit` to skip children. */
export function walk(node: TS.Node, visit: (node: TS.Node) => boolean | void): void {
  const step = (child: TS.Node): void => {
    if (visit(child) === false) return;
    ts.forEachChild(child, step);
  };
  ts.forEachChild(node, step);
}

/** 1-based line of a node's first character (comments before it are skipped). */
export function lineOf(node: TS.Node): number {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** The function behind a handler expression, if it is written in place. */
export function asFunction(node: TS.Node): TS.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return node;
  }
  if (ts.isMethodDeclaration(node)) return node;
  return undefined;
}
