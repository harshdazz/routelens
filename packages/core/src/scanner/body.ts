import type TS from "typescript";
import type { ParsedFile, SourceProject } from "./project.js";
import { lineOf, memberName, propertyNameText, ts, unwrap, walk } from "./ts.js";
import { readZodSchema, sampleOf } from "./zod.js";

/** The body a route expects, as RouteLens understood it from the code. */
export interface RouteBody {
  /** A JSON value to send. */
  sample: unknown;
  /** False when RouteLens could not check every rule, so the server may reject the sample. */
  exact: boolean;
  /** "zod": from a zod schema; "fields": only the field names the handler reads. */
  from: "zod" | "fields";
  /** Where the zod schema is declared, when it has a name. Paths are relative to the root. */
  schema?: { name: string; file: string; line: number };
  /** Why the sample is not exact. */
  notes: string[];
}

/** A piece of code to search, with the file it is in. */
export interface CodeRegion {
  file: ParsedFile;
  node: TS.Node;
}

const PARSE_METHODS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync", "spa"]);
const BODY_NAMES = new Set(["body", "data", "payload", "input", "json", "values", "raw"]);

/**
 * Find what body a route handler expects:
 * 1. a zod schema it parses with (`Schema.parse(await request.json())`, `Schema.safeParse(req.body)`),
 *    preferring calls whose argument is clearly the request body;
 * 2. a zod schema passed to a middleware (`validate(CreateUser)`, `validate({ body: CreateUser })`);
 * 3. without zod, the keys it destructures from the body (`const { email } = req.body`).
 */
export async function findRequestBody(
  project: SourceProject,
  regions: readonly CodeRegion[],
  middleware: readonly CodeRegion[] = [],
): Promise<RouteBody | undefined> {
  const candidates: Array<{ file: ParsedFile; schema: TS.Expression; score: number }> = [];

  for (const { file, node } of regions) {
    walk(node, (child) => {
      if (!ts.isCallExpression(child)) return;
      const callee = unwrap(child.expression);
      const method = memberName(callee);
      if (
        method === undefined ||
        !PARSE_METHODS.has(method) ||
        !ts.isPropertyAccessExpression(callee)
      )
        return;
      candidates.push({ file, schema: callee.expression, score: bodyScore(child.arguments[0]) });
    });
  }
  for (const { file, node } of middleware) {
    for (const schema of middlewareSchemas(node)) candidates.push({ file, schema, score: 1 });
  }

  // Best score first; the order in the code breaks ties (sort is stable).
  candidates.sort((left, right) => right.score - left.score);
  for (const candidate of candidates) {
    const model = await readZodSchema(project, candidate.file, candidate.schema);
    if (!model) continue;
    const sample = sampleOf(model);
    return {
      sample: sample.value,
      exact: sample.exact,
      from: "zod",
      ...(await schemaLocation(project, candidate.file, candidate.schema)),
      notes: sample.notes,
    };
  }

  const fields = destructuredBodyFields(regions);
  if (fields.length === 0) return undefined;
  return {
    sample: Object.fromEntries(fields.map((field) => [field, "example"])),
    exact: false,
    from: "fields",
    notes: ["no zod schema, so RouteLens only knows the field names the handler reads"],
  };
}

/** True when a handler reads the request body (`req.body`, `await request.json()`). */
export function readsRequestBody(node: TS.Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (found) return false;
    if (isBodyExpression(child)) found = true;
    return undefined;
  });
  return found;
}

/** `req.body`, `request.json()`, `await req.json()`. */
function isBodyExpression(node: TS.Node): boolean {
  const inner = ts.isAwaitExpression(node) ? unwrap(node.expression) : node;
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === "body") {
    return ts.isIdentifier(inner.expression) && /^req(uest)?$/i.test(inner.expression.text);
  }
  if (ts.isCallExpression(inner) && memberName(unwrap(inner.expression)) === "json") {
    const owner = unwrap(inner.expression);
    return (
      ts.isPropertyAccessExpression(owner) &&
      ts.isIdentifier(owner.expression) &&
      /^req(uest)?$/i.test(owner.expression.text)
    );
  }
  return false;
}

/** 2: clearly the request body; 1: a variable named like a body; 0: anything else. */
function bodyScore(argument: TS.Expression | undefined): number {
  if (!argument) return 0;
  const node = unwrap(argument);
  if (isBodyExpression(node)) return 2;
  if (ts.isIdentifier(node) && BODY_NAMES.has(node.text)) return 1;
  return 0;
}

/** Schemas passed to a middleware call: `validate(Schema)` or `validate({ body: Schema })`. */
function middlewareSchemas(node: TS.Node): TS.Expression[] {
  if (!ts.isCallExpression(node)) return [];
  const schemas: TS.Expression[] = [];
  for (const argument of node.arguments) {
    const inner = unwrap(argument);
    if (ts.isObjectLiteralExpression(inner)) {
      for (const property of inner.properties) {
        if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === "body") {
          schemas.push(property.initializer);
        }
      }
    } else if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner)) {
      schemas.push(inner);
    }
  }
  return schemas;
}

/** `const { email, plan } = req.body` → ["email", "plan"]. */
function destructuredBodyFields(regions: readonly CodeRegion[]): string[] {
  const fields: string[] = [];
  for (const { node } of regions) {
    walk(node, (child) => {
      if (
        ts.isVariableDeclaration(child) &&
        ts.isObjectBindingPattern(child.name) &&
        child.initializer &&
        isBodyExpression(unwrap(child.initializer))
      ) {
        for (const element of child.name.elements) {
          const key =
            propertyNameText(element.propertyName) ??
            (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if (key !== undefined && !element.dotDotDotToken && !fields.includes(key))
            fields.push(key);
        }
      }
    });
  }
  return fields;
}

async function schemaLocation(
  project: SourceProject,
  file: ParsedFile,
  schema: TS.Expression,
): Promise<{ schema?: RouteBody["schema"] }> {
  const node = unwrap(schema);
  if (!ts.isIdentifier(node)) return {};
  const binding = await project.resolveIdentifier(file, node);
  if (binding?.kind !== "value") return {};
  const declaration = ts.isVariableDeclaration(binding.node.parent)
    ? binding.node.parent
    : binding.node;
  return {
    schema: {
      name: node.text,
      file: project.relative(binding.file.path),
      line: lineOf(declaration),
    },
  };
}
