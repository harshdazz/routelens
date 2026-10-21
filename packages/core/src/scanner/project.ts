import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type TS from "typescript";
import { memberName, propertyNameText, scriptKindOf, stringValue, ts, unwrap } from "./ts.js";

/** Files bigger than this are bundles or generated code, not route handlers. */
const MAX_FILE_BYTES = 1_000_000;
/** How many imports, exports and assignments to follow before giving up (stops cycles). */
const MAX_DEPTH = 12;

export interface ParsedFile {
  /** Absolute path. */
  path: string;
  sourceFile: TS.SourceFile;
}

/** What a name or an expression refers to, after following imports, exports and consts. */
export type Binding =
  /** A value written in a project file: an expression, a function or a class. */
  | { kind: "value"; file: ParsedFile; node: TS.Node }
  /** A function parameter: its value is only known at the call sites. */
  | { kind: "param"; file: ParsedFile; node: TS.ParameterDeclaration; index: number }
  /** Something exported by a package: `name` is an export name, "default" or "*". */
  | { kind: "external"; module: string; name: string }
  /** The namespace of a project module (`import * as schemas from "./schemas"`). */
  | { kind: "module"; file: ParsedFile };

/** A name as declared in a file, before following it anywhere. */
type Declaration =
  | { kind: "value"; node: TS.Node }
  | { kind: "import"; specifier: string; imported: string }
  | { kind: "param"; node: TS.ParameterDeclaration; index: number }
  | { kind: "unknown" };

/**
 * The files of one project, parsed on demand and linked by their imports (ADR-0007).
 * Module paths are resolved the way TypeScript resolves them, with the project's tsconfig
 * or jsconfig (`paths` aliases, `./x.js` → `x.ts`). Nothing outside `root` is read.
 */
export class SourceProject {
  private readonly files = new Map<string, Promise<ParsedFile | undefined>>();
  private readonly modules = new Map<string, string | undefined>();

  private constructor(
    /** Folder whose files may be read; paths in results are relative to it. */
    readonly root: string,
    private readonly options: TS.CompilerOptions,
  ) {}

  /** `dir` is the folder being scanned; its tsconfig (or one above it, inside `root`) is used. */
  static open(dir: string, root = dir): SourceProject {
    return new SourceProject(path.resolve(root), compilerOptionsFor(path.resolve(dir), root));
  }

  /** Parse a file (cached). `undefined` if it cannot be read, is too big or is outside root. */
  file(filePath: string): Promise<ParsedFile | undefined> {
    const absolute = path.resolve(filePath);
    let parsed = this.files.get(absolute);
    if (!parsed) {
      parsed = this.inRoot(absolute) ? parseFile(absolute) : Promise.resolve(undefined);
      this.files.set(absolute, parsed);
    }
    return parsed;
  }

  /** Path relative to the root, with `/`. */
  relative(filePath: string): string {
    return path.relative(this.root, filePath).split(path.sep).join("/");
  }

  /** The project file an import specifier points to, or `undefined` for packages. */
  resolveModule(specifier: string, fromFile: string): string | undefined {
    const key = `${fromFile}\0${specifier}`;
    if (this.modules.has(key)) return this.modules.get(key);
    const resolved =
      resolveWith(specifier, fromFile, this.options) ??
      resolveWith(specifier, fromFile, { ...this.options, ...bundlerResolution() });
    const result = resolved && this.inRoot(resolved) ? resolved : undefined;
    this.modules.set(key, result);
    return result;
  }

  /** What an expression refers to: follows identifiers, `ns.name`, `obj.key` and `require()`. */
  async resolveExpression(
    file: ParsedFile,
    expression: TS.Expression,
    depth = 0,
  ): Promise<Binding | undefined> {
    if (depth > MAX_DEPTH) return undefined;
    const node = unwrap(expression);

    if (ts.isIdentifier(node)) return this.resolveIdentifier(file, node, depth + 1);

    const required = requiredModule(node);
    if (required !== undefined) return this.resolveImport(file, required, "*", depth + 1);

    const member = memberName(node);
    if (
      member !== undefined &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    ) {
      const owner = await this.resolveExpression(file, node.expression, depth + 1);
      if (!owner) return undefined;
      if (owner.kind === "external") {
        return owner.name === "*" || owner.name === "default"
          ? { kind: "external", module: owner.module, name: member }
          : undefined;
      }
      if (owner.kind === "module") return this.resolveExport(owner.file, member, depth + 1);
      if (owner.kind === "value" && ts.isObjectLiteralExpression(owner.node)) {
        return this.resolveObjectProperty(owner.file, owner.node, member, depth + 1);
      }
      return undefined;
    }

    return { kind: "value", file, node };
  }

  /** What an identifier refers to, looking in the enclosing scopes and then the imports. */
  async resolveIdentifier(
    file: ParsedFile,
    identifier: TS.Identifier,
    depth = 0,
  ): Promise<Binding | undefined> {
    return this.followDeclaration(file, declarationInScope(identifier, identifier.text), depth);
  }

  /** What a top-level name of `file` refers to. */
  async resolveName(file: ParsedFile, name: string, depth = 0): Promise<Binding | undefined> {
    return this.followDeclaration(file, declarationIn(file.sourceFile.statements, name), depth);
  }

  /** What `file` exports as `name` ("default", "*" or a name), for ESM and CommonJS. */
  async resolveExport(file: ParsedFile, name: string, depth = 0): Promise<Binding | undefined> {
    if (depth > MAX_DEPTH) return undefined;
    const statements = file.sourceFile.statements;
    const commonJs = commonJsExports(statements);

    if (name === "*") {
      return commonJs.whole
        ? this.resolveExpression(file, commonJs.whole, depth + 1)
        : { kind: "module", file };
    }

    for (const statement of statements) {
      if (name === "default" && ts.isExportAssignment(statement)) {
        return this.resolveExpression(file, statement.expression, depth + 1);
      }
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
        if (isDefault ? name === "default" : statement.name?.text === name) {
          return { kind: "value", file, node: statement };
        }
      }
      if (
        ts.isVariableStatement(statement) &&
        hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return this.resolveName(file, name, depth + 1);
          }
        }
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const from = stringValue(statement.moduleSpecifier);
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (element.name.text !== name) continue;
            const local = element.propertyName?.text ?? element.name.text;
            return from === undefined
              ? this.resolveName(file, local, depth + 1)
              : this.resolveImport(file, from, local, depth + 1);
          }
        } else if (!clause && from !== undefined && name !== "default") {
          const target = await this.importedFile(file, from);
          const found = target && (await this.resolveExport(target, name, depth + 1));
          if (found && found.kind !== "module") return found;
        }
      }
    }

    const assigned = name === "default" ? commonJs.whole : commonJs.named.get(name);
    if (assigned) return this.resolveExpression(file, assigned, depth + 1);
    if (commonJs.whole && name !== "default") {
      const whole = await this.resolveExpression(file, commonJs.whole, depth + 1);
      if (whole?.kind === "value" && ts.isObjectLiteralExpression(whole.node)) {
        return this.resolveObjectProperty(whole.file, whole.node, name, depth + 1);
      }
    }
    return undefined;
  }

  private async followDeclaration(
    file: ParsedFile,
    declaration: Declaration | undefined,
    depth: number,
  ): Promise<Binding | undefined> {
    if (!declaration || depth > MAX_DEPTH) return undefined;
    switch (declaration.kind) {
      case "value":
        if (ts.isIdentifier(declaration.node) || isAlias(declaration.node)) {
          return this.resolveExpression(file, declaration.node as TS.Expression, depth + 1);
        }
        return { kind: "value", file, node: declaration.node };
      case "import":
        return this.resolveImport(file, declaration.specifier, declaration.imported, depth + 1);
      case "param":
        return { kind: "param", file, node: declaration.node, index: declaration.index };
      default:
        return undefined;
    }
  }

  /** What `import { imported } from "specifier"` in `file` refers to. */
  async resolveImport(
    file: ParsedFile,
    specifier: string,
    imported: string,
    depth = 0,
  ): Promise<Binding | undefined> {
    const target = await this.importedFile(file, specifier);
    if (!target) {
      return isRelative(specifier)
        ? undefined
        : { kind: "external", module: specifier, name: imported };
    }
    return this.resolveExport(target, imported, depth + 1);
  }

  private async importedFile(file: ParsedFile, specifier: string): Promise<ParsedFile | undefined> {
    const resolved = this.resolveModule(specifier, file.path);
    return resolved ? this.file(resolved) : undefined;
  }

  private async resolveObjectProperty(
    file: ParsedFile,
    object: TS.ObjectLiteralExpression,
    name: string,
    depth: number,
  ): Promise<Binding | undefined> {
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) {
        return this.resolveExpression(file, property.initializer, depth + 1);
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
        return this.resolveIdentifier(file, property.name, depth + 1);
      }
    }
    return undefined;
  }

  private inRoot(filePath: string): boolean {
    const relative = path.relative(this.root, filePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }
}

/** The specifier of `require("x")`, if the node is one. */
export function requiredModule(node: TS.Node): string | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1
  ) {
    return stringValue(node.arguments[0]);
  }
  return undefined;
}

/** The innermost function that contains `node`, or `undefined` at the top level. */
export function enclosingFunction(node: TS.Node): TS.SignatureDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

function hasModifier(node: TS.Node, kind: TS.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/** `x`, `ns.x` and `require("x")` only name another value, so they are followed. */
function isAlias(node: TS.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    requiredModule(node) !== undefined
  );
}

/** Where `name` is declared, looking from `node` outwards through blocks and functions. */
function declarationInScope(node: TS.Node, name: string): Declaration | undefined {
  for (let current: TS.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      const index = current.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
      );
      const parameter = current.parameters[index];
      if (parameter) return { kind: "param", node: parameter, index };
    }
    const statements =
      ts.isSourceFile(current) || ts.isBlock(current) || ts.isModuleBlock(current)
        ? current.statements
        : ts.isCaseClause(current) || ts.isDefaultClause(current)
          ? current.statements
          : undefined;
    if (statements) {
      const found = declarationIn(statements, name);
      if (found) return found;
    }
  }
  return undefined;
}

/** A declaration of `name` among `statements` (not inside nested blocks). */
function declarationIn(
  statements: TS.NodeArray<TS.Statement>,
  name: string,
): Declaration | undefined {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const found = variableDeclaration(declaration, name);
        if (found) return found;
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return { kind: "value", node: statement };
    } else if (ts.isImportDeclaration(statement)) {
      const found = importDeclaration(statement, name);
      if (found) return found;
    } else if (ts.isImportEqualsDeclaration(statement) && statement.name.text === name) {
      const reference = statement.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        const specifier = stringValue(reference.expression);
        if (specifier !== undefined) return { kind: "import", specifier, imported: "*" };
      }
    }
  }
  return undefined;
}

function variableDeclaration(
  declaration: TS.VariableDeclaration,
  name: string,
): Declaration | undefined {
  const initializer = declaration.initializer && unwrap(declaration.initializer);

  if (ts.isIdentifier(declaration.name)) {
    if (declaration.name.text !== name) return undefined;
    if (!initializer) return { kind: "unknown" };
    // const x = require("m"), const x = require("m").y
    const whole = requiredModule(initializer);
    if (whole !== undefined) return { kind: "import", specifier: whole, imported: "*" };
    if (ts.isPropertyAccessExpression(initializer)) {
      const from = requiredModule(unwrap(initializer.expression));
      if (from !== undefined)
        return { kind: "import", specifier: from, imported: initializer.name.text };
    }
    return { kind: "value", node: initializer };
  }

  // const { a, b: c } = require("m")
  if (ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name) || element.name.text !== name) continue;
      const from = initializer && requiredModule(initializer);
      const imported = propertyNameText(element.propertyName) ?? element.name.text;
      return from === undefined
        ? { kind: "unknown" }
        : { kind: "import", specifier: from, imported };
    }
  }
  return undefined;
}

function importDeclaration(statement: TS.ImportDeclaration, name: string): Declaration | undefined {
  const specifier = stringValue(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (specifier === undefined || !clause || clause.isTypeOnly) return undefined;
  if (clause.name?.text === name) return { kind: "import", specifier, imported: "default" };
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
    return { kind: "import", specifier, imported: "*" };
  }
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (element.name.text === name && !element.isTypeOnly) {
        return { kind: "import", specifier, imported: element.propertyName?.text ?? name };
      }
    }
  }
  return undefined;
}

/** `module.exports = x` / `export = x` (whole) and `module.exports.a = x` / `exports.a = x`. */
function commonJsExports(statements: TS.NodeArray<TS.Statement>): {
  whole: TS.Expression | undefined;
  named: Map<string, TS.Expression>;
} {
  let whole: TS.Expression | undefined;
  const named = new Map<string, TS.Expression>();
  for (const statement of statements) {
    if (ts.isExportAssignment(statement) && statement.isExportEquals) {
      whole = statement.expression;
      continue;
    }
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const target = expression.left.getText();
    const match = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
    if (target === "module.exports") whole = expression.right;
    else if (match?.[1]) named.set(match[1], expression.right);
  }
  return { whole, named };
}

async function parseFile(filePath: string): Promise<ParsedFile | undefined> {
  try {
    if ((await stat(filePath)).size > MAX_FILE_BYTES) return undefined;
    const text = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindOf(filePath),
    );
    return { path: filePath, sourceFile };
  } catch {
    return undefined;
  }
}

/** Resolution used by bundlers (Next.js, Vite, tsx): extensionless and `paths` imports work. */
function bundlerResolution(): TS.CompilerOptions {
  return { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function resolveWith(
  specifier: string,
  fromFile: string,
  options: TS.CompilerOptions,
): string | undefined {
  const { resolvedModule } = ts.resolveModuleName(specifier, fromFile, options, ts.sys);
  if (!resolvedModule || resolvedModule.isExternalLibraryImport) return undefined;
  if (!SOURCE_EXTENSIONS.has(resolvedModule.extension)) return undefined;
  return path.resolve(resolvedModule.resolvedFileName);
}

/**
 * Compiler options from the nearest tsconfig.json or jsconfig.json at or above `dir`
 * (but not above `root`). Only module resolution matters here: `paths`, `baseUrl` and
 * `moduleResolution`. Old resolution modes are upgraded to Bundler so modern imports work.
 */
function compilerOptionsFor(dir: string, root: string): TS.CompilerOptions {
  const base: TS.CompilerOptions = { allowJs: true, resolveJsonModule: false };
  const configFile = findConfigFile(dir, path.resolve(root));
  let options: TS.CompilerOptions = {};
  if (configFile) {
    const { config } = ts.readConfigFile(configFile, ts.sys.readFile);
    if (config) {
      // readDirectory returns nothing: we only want the options, not the file list.
      const host: TS.ParseConfigHost = { ...ts.sys, readDirectory: () => [] };
      options = ts.parseJsonConfigFileContent(config, host, path.dirname(configFile)).options;
    }
  }
  const resolution = options.moduleResolution;
  const modern =
    resolution === ts.ModuleResolutionKind.Bundler ||
    resolution === ts.ModuleResolutionKind.Node16 ||
    resolution === ts.ModuleResolutionKind.NodeNext;
  return {
    ...options,
    ...base,
    ...(modern ? {} : bundlerResolution()),
  };
}

function findConfigFile(dir: string, root: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    if (current === root || path.dirname(current) === current) return undefined;
    if (path.relative(root, current).startsWith("..")) return undefined;
  }
}
