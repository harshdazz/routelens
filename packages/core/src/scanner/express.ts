import type TS from "typescript";
import { findRequestBody, type CodeRegion } from "./body.js";
import { joinRoutePath } from "./paths.js";
import type { ParsedFile, SourceProject } from "./project.js";
import type { DetectedRoute, SkippedRoute } from "./routes.js";
import { asFunction, lineOf, memberName, stringValue, ts, unwrap, walk } from "./ts.js";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
/** Parameters with these names (or typed `Express`, `Router`…) are treated as an app or router. */
const APP_PARAMETER_NAMES = /^(app|router|server|api|routes)$/;
const APP_PARAMETER_TYPES = /\b(Express|Application|Router|IRouter)\b/;
/** Cheap text check before parsing a file. */
const MAYBE_EXPRESS = /express|\.(get|post|put|patch|delete|all|use|route)\s*\(/;

/** An Express app, a router, or a function parameter that receives one. */
interface RouterNode {
  kind: "app" | "router" | "param";
  routes: Array<{
    method: string;
    path: string;
    file: ParsedFile;
    line: number;
    handlers: TS.Expression[];
  }>;
  mounts: Array<{ prefix: string; child: RouterNode }>;
  mounted: boolean;
}

/**
 * Express routes (ADR-0007): `app.get(path, …)`, `router.route(path).get(…)`, and routers
 * mounted with `app.use(prefix, router)` across files, in ES modules and CommonJS.
 * Only receivers that come from `express()`, `express.Router()` / `Router()`, or a parameter
 * named or typed like an app count, so `axios.post("/x")` or `map.get("/x")` are ignored.
 */
export async function scanExpress(
  project: SourceProject,
  filePaths: readonly string[],
  skipped: SkippedRoute[],
): Promise<DetectedRoute[]> {
  const nodes = new Map<TS.Node, RouterNode>();
  const parsed: ParsedFile[] = [];

  for (const filePath of filePaths) {
    const file = await project.file(filePath);
    if (file && MAYBE_EXPRESS.test(file.sourceFile.text)) parsed.push(file);
  }

  // 1. Apps and routers: `const app = express()`, `const router = Router()`.
  for (const file of parsed) {
    const declarations: TS.Expression[] = [];
    walk(file.sourceFile, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer)
        declarations.push(unwrap(node.initializer));
    });
    for (const value of declarations) {
      const kind = await creatorKind(project, file, value);
      if (kind) nodes.set(value, { kind, routes: [], mounts: [], mounted: false });
    }
  }

  const receiver = async (
    file: ParsedFile,
    expression: TS.Expression,
  ): Promise<RouterNode | undefined> => {
    const node = unwrap(expression);
    // A name, `a.b` or `require("./routes")` may be a router; literals and functions are not.
    if (
      !ts.isIdentifier(node) &&
      !ts.isPropertyAccessExpression(node) &&
      !ts.isCallExpression(node)
    ) {
      return undefined;
    }
    const binding = await project.resolveExpression(file, node);
    if (binding?.kind === "value") return nodes.get(binding.node);
    if (binding?.kind === "param" && isAppParameter(binding.node)) {
      let param = nodes.get(binding.node);
      if (!param) {
        param = { kind: "param", routes: [], mounts: [], mounted: false };
        nodes.set(binding.node, param);
      }
      return param;
    }
    return undefined;
  };

  // 2. Routes and mounts.
  const calls: Array<{ file: ParsedFile; call: TS.CallExpression }> = [];
  for (const file of parsed) {
    if (isTestFile(project.relative(file.path))) continue;
    walk(file.sourceFile, (node) => {
      if (ts.isCallExpression(node)) calls.push({ file, call: node });
    });
  }

  for (const { file, call } of calls) {
    const callee = unwrap(call.expression);
    const method = memberName(callee);
    if (method === undefined || !ts.isPropertyAccessExpression(callee)) continue;
    const owner = unwrap(callee.expression);

    if (ROUTE_METHODS.has(method)) {
      // router.route("/:id").get(…).put(…)
      const chain = routeChain(owner);
      const target = await receiver(file, chain ? chain.receiver : owner);
      if (!target) continue;
      const paths = chain ? [chain.path] : routePaths(call.arguments[0]);
      const handlers = (chain ? call.arguments : call.arguments.slice(1)).slice();
      if (!chain && handlers.length === 0) continue;
      for (const routePath of paths) {
        if (routePath === undefined) {
          skipped.push({
            file: project.relative(file.path),
            line: lineOf(call),
            reason: "the path is not a plain string (regex or variable)",
          });
          continue;
        }
        target.routes.push({ method, path: routePath, file, line: lineOf(callee.name), handlers });
      }
    } else if (method === "use") {
      const target = await receiver(file, owner);
      if (!target) continue;
      const prefix = stringValue(call.arguments[0]);
      const children = prefix === undefined ? call.arguments : call.arguments.slice(1);
      for (const argument of children) {
        const child = await receiver(file, argument);
        if (child && child !== target) {
          target.mounts.push({ prefix: prefix ?? "", child });
          child.mounted = true;
        }
      }
    }
  }

  // 3. Functions that receive the app: `registerHealth(app)` mounts their routes on it.
  const hasParameters = [...nodes.values()].some((node) => node.kind === "param");
  for (const { file, call } of hasParameters ? calls : []) {
    if (!call.arguments.some((argument) => ts.isIdentifier(unwrap(argument)))) continue;
    const callee = await project.resolveExpression(file, call.expression);
    if (callee?.kind !== "value") continue;
    const fn = asFunction(callee.node);
    if (!fn) continue;
    for (const [index, parameter] of fn.parameters.entries()) {
      const param = nodes.get(parameter);
      const argument = call.arguments[index];
      if (!param || !argument) continue;
      const parent = await receiver(file, argument);
      if (parent && parent !== param) {
        parent.mounts.push({ prefix: "", child: param });
        param.mounted = true;
      }
    }
  }

  // 4. Walk from every app (and every router nobody mounts) to get full paths.
  const routes: DetectedRoute[] = [];
  const visit = async (node: RouterNode, prefix: string, stack: Set<RouterNode>): Promise<void> => {
    if (stack.has(node)) return;
    stack.add(node);
    for (const route of node.routes) {
      routes.push(await toRoute(project, route, joinRoutePath(prefix, route.path)));
    }
    for (const mount of node.mounts)
      await visit(mount.child, joinRoutePath(prefix, mount.prefix), stack);
    stack.delete(node);
  };
  for (const node of nodes.values()) {
    if (!node.mounted) await visit(node, "", new Set());
  }
  return routes;
}

async function toRoute(
  project: SourceProject,
  route: RouterNode["routes"][number],
  fullPath: string,
): Promise<DetectedRoute> {
  const anyMethod = route.method === "all";
  const method = anyMethod ? "GET" : route.method.toUpperCase();
  const regions: CodeRegion[] = [];
  const middleware: CodeRegion[] = [];
  for (const handler of route.handlers.flatMap((item) => {
    const inner = unwrap(item);
    return ts.isArrayLiteralExpression(inner) ? [...inner.elements] : [inner];
  })) {
    if (asFunction(handler)) {
      regions.push({ file: route.file, node: handler });
    } else if (ts.isCallExpression(handler)) {
      middleware.push({ file: route.file, node: handler });
    } else {
      const binding = await project.resolveExpression(route.file, handler);
      if (binding?.kind === "value" && asFunction(binding.node)) {
        regions.push({ file: binding.file, node: binding.node });
      }
    }
  }

  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await findRequestBody(project, regions, middleware);
  return {
    key: `${method} ${fullPath}`,
    method: method as DetectedRoute["method"],
    path: fullPath,
    anyMethod,
    framework: "express",
    file: project.relative(route.file.path),
    line: route.line,
    ...(body ? { body } : {}),
  };
}

/** "app" for `express()`, "router" for `express.Router()` / `Router()` / `new Router()`. */
async function creatorKind(
  project: SourceProject,
  file: ParsedFile,
  value: TS.Expression,
): Promise<"app" | "router" | undefined> {
  if (!ts.isCallExpression(value) && !ts.isNewExpression(value)) return undefined;
  const callee = await project.resolveExpression(file, value.expression);
  if (callee?.kind !== "external" || callee.module !== "express") return undefined;
  if (callee.name === "default" || callee.name === "*") return "app";
  if (callee.name === "Router") return "router";
  return undefined;
}

/** `router.route("/:id")` at the start of a `.get().post()` chain. */
function routeChain(
  node: TS.Expression,
): { receiver: TS.Expression; path: string | undefined } | undefined {
  let current = unwrap(node);
  for (;;) {
    if (!ts.isCallExpression(current)) return undefined;
    const callee = unwrap(current.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    if (callee.name.text === "route")
      return { receiver: callee.expression, path: stringValue(current.arguments[0]) };
    if (!ROUTE_METHODS.has(callee.name.text)) return undefined;
    current = unwrap(callee.expression);
  }
}

/** One path, or several from an array (`app.get(["/a", "/b"], …)`); `undefined` for a regex. */
function routePaths(argument: TS.Expression | undefined): Array<string | undefined> {
  const node = argument && unwrap(argument);
  if (node && ts.isArrayLiteralExpression(node))
    return node.elements.map((element) => stringValue(element));
  return [stringValue(node)];
}

function isAppParameter(parameter: TS.ParameterDeclaration): boolean {
  if (!ts.isIdentifier(parameter.name)) return false;
  if (parameter.type) return APP_PARAMETER_TYPES.test(parameter.type.getText());
  return APP_PARAMETER_NAMES.test(parameter.name.text);
}

/** Test files call `app.get()` too, but they are not routes. */
export function isTestFile(relativePath: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|e2e|cypress|playwright)\//.test(relativePath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
  );
}
