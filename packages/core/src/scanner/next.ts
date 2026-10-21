import path from "node:path";
import type TS from "typescript";
import { HTTP_METHODS, METHODS_WITHOUT_BODY, type HttpMethod } from "../model.js";
import { findRequestBody, readsRequestBody } from "./body.js";
import { joinRoutePath, nextRoutePath } from "./paths.js";
import type { Binding, ParsedFile, SourceProject } from "./project.js";
import type { DetectedRoute, RouteFramework } from "./routes.js";
import {
  asFunction,
  lineOf,
  memberName,
  propertyNameText,
  stringValue,
  ts,
  unwrap,
  walk,
} from "./ts.js";

const METHOD_NAMES = new Set<string>(HTTP_METHODS);
const ROUTE_FILE = /^route\.m?[jt]sx?$/;
const SOURCE_FILE = /\.m?[jt]sx?$/;

/**
 * Next.js App Router route handlers (ADR-0007): `app/**\/route.ts` (or `src/app/…`), one route
 * per exported HTTP method. Exports may be functions, consts, wrapped handlers
 * (`withAuth(…)`), `export { handler as GET }` or re-exports from another file.
 */
export async function scanNextApp(
  project: SourceProject,
  dir: string,
  filePaths: readonly string[],
  basePath: string,
): Promise<DetectedRoute[]> {
  const routes: DetectedRoute[] = [];
  for (const filePath of filePaths) {
    const segments = segmentsBelow(dir, filePath, ["app", "src/app"]);
    if (!segments || !ROUTE_FILE.test(segments.at(-1) ?? "")) continue;
    const routePath = nextRoutePath(segments.slice(0, -1), "app");
    const file = routePath === undefined ? undefined : await project.file(filePath);
    if (!file || routePath === undefined) continue;

    for (const handler of await exportedHandlers(project, file)) {
      const method = handler.name as HttpMethod;
      const regions =
        handler.binding?.kind === "value"
          ? [{ file: handler.binding.file, node: handler.binding.node }]
          : [];
      const body = METHODS_WITHOUT_BODY.includes(method)
        ? undefined
        : await findRequestBody(project, regions);
      routes.push(
        route(
          "next-app",
          method,
          joinRoutePath(basePath, routePath),
          project,
          file,
          handler.line,
          body,
        ),
      );
    }
  }
  return routes;
}

/**
 * Next.js Pages API routes: `pages/api/**` (or `src/pages/api/…`), the default export.
 * Methods come from `req.method` checks; a handler without checks answers every method.
 */
export async function scanNextPages(
  project: SourceProject,
  dir: string,
  filePaths: readonly string[],
  basePath: string,
): Promise<DetectedRoute[]> {
  const routes: DetectedRoute[] = [];
  for (const filePath of filePaths) {
    const segments = segmentsBelow(dir, filePath, ["pages", "src/pages"]);
    if (
      !segments ||
      segments[0] !== "api" ||
      !SOURCE_FILE.test(filePath) ||
      filePath.endsWith(".d.ts")
    )
      continue;
    const names = [...segments.slice(0, -1), (segments.at(-1) ?? "").replace(SOURCE_FILE, "")];
    if (names.at(-1) === "index") names.pop();
    const routePath = nextRoutePath(names, "pages");
    const file = routePath === undefined ? undefined : await project.file(filePath);
    if (!file || routePath === undefined) continue;

    const exported = defaultExport(file.sourceFile);
    const binding = exported && (await project.resolveExport(file, "default"));
    if (!exported) continue;
    const handler = binding?.kind === "value" ? handlerFunction(binding) : undefined;
    const fullPath = joinRoutePath(basePath, routePath);
    const exportLine = lineOf(exported);

    const checks = handler ? methodChecks(handler.node) : [];
    if (checks.length === 0) {
      const region =
        handler ??
        (binding?.kind === "value" ? { file: binding.file, node: binding.node } : undefined);
      const regions = region ? [region] : [];
      const body = await findRequestBody(project, regions);
      const method = body || (region && readsRequestBody(region.node)) ? "POST" : "GET";
      routes.push({
        ...route("next-pages", method, fullPath, project, file, exportLine, body),
        anyMethod: true,
      });
      continue;
    }
    for (const check of checks) {
      const regions = [{ file: handler?.file ?? file, node: check.region }];
      const body = METHODS_WITHOUT_BODY.includes(check.method)
        ? undefined
        : await findRequestBody(project, regions);
      routes.push(route("next-pages", check.method, fullPath, project, file, check.line, body));
    }
  }
  return routes;
}

/** `basePath: "/docs"` from next.config.(js|mjs|cjs|ts), or "". */
export async function nextBasePath(project: SourceProject, dir: string): Promise<string> {
  for (const name of [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
    "next.config.mts",
  ]) {
    const file = await project.file(path.join(dir, name));
    if (!file) continue;
    let basePath = "";
    walk(file.sourceFile, (node) => {
      if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === "basePath") {
        basePath = stringValue(node.initializer) ?? basePath;
      }
    });
    return basePath;
  }
  return "";
}

function route(
  framework: RouteFramework,
  method: HttpMethod,
  routePath: string,
  project: SourceProject,
  file: ParsedFile,
  line: number,
  body: DetectedRoute["body"],
): DetectedRoute {
  return {
    key: `${method} ${routePath}`,
    method,
    path: routePath,
    anyMethod: false,
    framework,
    file: project.relative(file.path),
    line,
    ...(body ? { body } : {}),
  };
}

/** Folder and file names of `filePath` below the first of `roots` (inside `dir`) that holds it. */
function segmentsBelow(
  dir: string,
  filePath: string,
  roots: readonly string[],
): string[] | undefined {
  const relative = path.relative(dir, filePath).split(path.sep).join("/");
  for (const root of roots) {
    if (relative.startsWith(`${root}/`)) return relative.slice(root.length + 1).split("/");
  }
  return undefined;
}

/** Exported HTTP-method handlers of a route.ts file, with the line of each export. */
async function exportedHandlers(
  project: SourceProject,
  file: ParsedFile,
): Promise<Array<{ name: string; line: number; binding: Binding | undefined }>> {
  const handlers: Array<{ name: string; line: number; binding: Binding | undefined }> = [];
  for (const statement of file.sourceFile.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (
      exported &&
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      METHOD_NAMES.has(statement.name.text)
    ) {
      handlers.push({
        name: statement.name.text,
        line: lineOf(statement),
        binding: { kind: "value", file, node: statement },
      });
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !METHOD_NAMES.has(declaration.name.text))
          continue;
        const binding = await project.resolveName(file, declaration.name.text);
        handlers.push({ name: declaration.name.text, line: lineOf(statement), binding });
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const from = stringValue(statement.moduleSpecifier);
      for (const element of statement.exportClause.elements) {
        if (!METHOD_NAMES.has(element.name.text) || element.isTypeOnly) continue;
        const local = element.propertyName?.text ?? element.name.text;
        const binding =
          from === undefined
            ? await project.resolveName(file, local)
            : await project.resolveImport(file, from, local);
        handlers.push({ name: element.name.text, line: lineOf(element), binding });
      }
    }
  }
  return handlers;
}

/** The `export default …` statement of a file. */
function defaultExport(sourceFile: TS.SourceFile): TS.Node | undefined {
  return sourceFile.statements.find(
    (statement) =>
      (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
      ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        )),
  );
}

/** The handler function: the value itself, or the function passed to a wrapper (`withX(fn)`). */
function handlerFunction(
  binding: Extract<Binding, { kind: "value" }>,
): { file: ParsedFile; node: TS.Node } | undefined {
  if (asFunction(binding.node)) return { file: binding.file, node: binding.node };
  if (ts.isCallExpression(binding.node)) {
    const inner = binding.node.arguments
      .map((argument) => unwrap(argument))
      .find((argument) => asFunction(argument));
    if (inner) return { file: binding.file, node: inner };
  }
  return undefined;
}

interface MethodCheck {
  method: HttpMethod;
  /** Where that method is handled: the `if` block or `case`, or the whole handler. */
  region: TS.Node;
  line: number;
}

/**
 * Methods a Pages API handler checks for: `req.method === "POST"`, `req.method !== "POST"`,
 * `switch (req.method) { case "GET": … }` and `["GET", "POST"].includes(req.method)`.
 */
function methodChecks(handler: TS.Node): MethodCheck[] {
  const checks: MethodCheck[] = [];
  const add = (value: string | undefined, region: TS.Node, line: number): void => {
    const method = value?.toUpperCase();
    if (method && METHOD_NAMES.has(method) && !checks.some((check) => check.method === method)) {
      checks.push({ method: method as HttpMethod, region, line });
    }
  };

  walk(handler, (node) => {
    if (ts.isSwitchStatement(node) && isMethodExpression(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) add(stringValue(clause.expression), clause, lineOf(clause));
      }
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const equal =
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsToken;
      const notEqual =
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken;
      if (!equal && !notEqual) return;
      const value = isMethodExpression(node.left)
        ? stringValue(node.right)
        : isMethodExpression(node.right)
          ? stringValue(node.left)
          : undefined;
      const statement = ts.isIfStatement(node.parent) ? node.parent : undefined;
      // `!==` guards the rest of the handler; `===` guards its own block.
      add(value, equal && statement ? statement.thenStatement : handler, lineOf(statement ?? node));
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (!ts.isPropertyAccessExpression(callee) || memberName(callee) !== "includes") return;
      const owner = unwrap(callee.expression);
      if (
        !ts.isArrayLiteralExpression(owner) ||
        !node.arguments[0] ||
        !isMethodExpression(node.arguments[0])
      )
        return;
      const statement = ts.isIfStatement(node.parent) ? node.parent : undefined;
      for (const element of owner.elements) {
        add(
          stringValue(element),
          statement ? statement.thenStatement : handler,
          lineOf(statement ?? node),
        );
      }
    }
  });
  return checks;
}

/** `req.method`, `request.method` or a variable named `method`. */
function isMethodExpression(expression: TS.Expression): boolean {
  const node = unwrap(expression);
  return (
    (ts.isPropertyAccessExpression(node) && node.name.text === "method") ||
    (ts.isIdentifier(node) && node.text === "method")
  );
}
