import type TS from "typescript";
import type { ParsedFile, SourceProject } from "./project.js";
import { lineOf, memberName, propertyNameText, stringValue, ts, unwrap } from "./ts.js";

/**
 * A static reader for zod schemas (ADR-0007): it reads `z.object({...})` and friends from
 * the syntax tree, never runs them, and makes a sample value that passes the schema.
 * Rules it cannot model (`.refine()`, a regex the sample misses…) make the sample "not exact".
 */

/** Recursive schemas (`z.lazy`) and long reference chains stop here. */
const MAX_DEPTH = 24;

interface Bound {
  value: number;
  inclusive: boolean;
}

type ModelShape =
  | {
      type: "string";
      format?: string;
      min?: number;
      max?: number;
      length?: number;
      startsWith?: string;
      endsWith?: string;
      includes?: string;
      uppercase?: boolean;
      regex?: RegExp;
    }
  | { type: "number"; int: boolean; min?: Bound; max?: Bound; multipleOf?: number }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "undefined" }
  | { type: "any" }
  | { type: "literal"; value: unknown }
  | { type: "enum"; values: unknown[] }
  | { type: "array"; item: ZodModel; min?: number; max?: number }
  | { type: "tuple"; items: ZodModel[] }
  | { type: "object"; shape: Array<[string, ZodModel]> }
  | { type: "record"; keys: unknown[] | undefined; value: ZodModel }
  | { type: "union"; options: ZodModel[] }
  | { type: "unsupported"; reason: string };

/** A zod schema as far as RouteLens understands it. */
export type ZodModel = ModelShape & {
  optional?: boolean;
  nullable?: boolean;
  /** `.default(value)` with a value written in the code. */
  fallback?: { value: unknown };
  /** Set by `.transform()`: the default value may not be a valid input. */
  transformed?: boolean;
  /** Why a sample may not pass: custom rules RouteLens cannot check. */
  caveats?: string[];
};

export interface ZodSample {
  value: unknown;
  /** False when RouteLens could not check every rule, so the sample may be rejected. */
  exact: boolean;
  /** Why the sample is not exact, e.g. "custom rule (.refine) on line 12". */
  notes: string[];
}

/** Read a zod schema expression. `undefined` when the expression is not a zod schema. */
export async function readZodSchema(
  project: SourceProject,
  file: ParsedFile,
  expression: TS.Expression,
): Promise<ZodModel | undefined> {
  return new ZodReader(project).model(file, expression, 0);
}

/** A sample value for a zod schema expression, or `undefined` when it is not zod. */
export async function zodSample(
  project: SourceProject,
  file: ParsedFile,
  expression: TS.Expression,
): Promise<ZodSample | undefined> {
  const model = await readZodSchema(project, file, expression);
  return model && sampleOf(model);
}

class ZodReader {
  constructor(private readonly project: SourceProject) {}

  async model(
    file: ParsedFile,
    expression: TS.Expression,
    depth: number,
  ): Promise<ZodModel | undefined> {
    if (depth > MAX_DEPTH)
      return { type: "any", caveats: ["the schema is nested too deep to read"] };
    const node = unwrap(expression);

    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const method = memberName(callee);
      if (
        method !== undefined &&
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      ) {
        const namespace = await this.namespacePath(file, callee.expression, 0);
        if (namespace !== undefined) return this.factory(file, [...namespace, method], node, depth);
        const base = await this.model(file, callee.expression, depth + 1);
        return base && this.modifier(file, base, method, node, depth);
      }
      if (ts.isIdentifier(callee)) {
        // import { object, string } from "zod"
        const binding = await this.project.resolveIdentifier(file, callee);
        if (
          binding?.kind === "external" &&
          isZodModule(binding.module) &&
          !isNamespaceName(binding.name)
        ) {
          return this.factory(file, [binding.name], node, depth);
        }
      }
      return undefined;
    }

    if (
      ts.isIdentifier(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      // `Base.shape.name` style references are rare; plain names are the common case.
      const binding = await this.project.resolveExpression(file, node);
      if (binding?.kind === "value" && isExpression(binding.node)) {
        return this.model(binding.file, binding.node, depth + 1);
      }
    }
    return undefined;
  }

  /** `[]` for the zod namespace (`z`), `["coerce"]` for `z.coerce`, `["iso"]` for `z.iso`. */
  private async namespacePath(
    file: ParsedFile,
    expression: TS.Expression,
    depth: number,
  ): Promise<string[] | undefined> {
    if (depth > 3) return undefined;
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const binding = await this.project.resolveIdentifier(file, node);
      if (binding?.kind === "external" && isZodModule(binding.module)) {
        if (isNamespaceName(binding.name)) return [];
        if (binding.name === "coerce" || binding.name === "iso") return [binding.name];
        return undefined;
      }
      // `z` re-exported through a file RouteLens could not follow.
      return binding === undefined && node.text === "z" ? [] : undefined;
    }
    const name = memberName(node);
    if (name && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const parent = await this.namespacePath(file, node.expression, depth + 1);
      if (parent?.length === 0 && (name === "coerce" || name === "iso" || name === "z")) {
        return name === "z" ? [] : [name];
      }
    }
    return undefined;
  }

  private async factory(
    file: ParsedFile,
    path: string[],
    call: TS.CallExpression,
    depth: number,
  ): Promise<ZodModel> {
    const args = call.arguments;
    const arg = (index: number): TS.Expression | undefined => args[index];
    const child = async (expression: TS.Expression | undefined): Promise<ZodModel> =>
      (expression && (await this.model(file, expression, depth + 1))) ??
      unsupported(`a value RouteLens cannot read on line ${lineOf(call)}`);
    const scope = path.length === 2 ? path[0] : "";
    const name = path.at(-1) ?? "";

    if (scope === "coerce") {
      if (name === "date") return { type: "string", format: "datetime" };
      if (name === "number" || name === "bigint") return { type: "number", int: name === "bigint" };
      if (name === "boolean") return { type: "boolean" };
      return { type: "string" };
    }
    if (scope === "iso") {
      return { type: "string", format: name === "datetime" ? "datetime" : name };
    }

    switch (name) {
      case "string":
        return { type: "string" };
      case "number":
      case "float32":
      case "float64":
        return { type: "number", int: false };
      case "int":
      case "int32":
      case "int64":
        return { type: "number", int: true };
      case "uint32":
      case "uint64":
        return { type: "number", int: true, min: { value: 0, inclusive: true } };
      case "boolean":
        return { type: "boolean" };
      case "stringbool":
        return { type: "literal", value: "true" };
      case "null":
        return { type: "null" };
      case "undefined":
      case "void":
        return { type: "undefined", optional: true };
      case "any":
      case "unknown":
      case "json":
        return { type: "any" };
      case "literal": {
        const value = literalValue(arg(0));
        if (!value) return unsupported(`a literal RouteLens cannot read on line ${lineOf(call)}`);
        return Array.isArray(value.value)
          ? { type: "enum", values: value.value }
          : { type: "literal", value: value.value };
      }
      case "enum":
      case "nativeEnum":
        return this.enumModel(file, arg(0), call);
      case "object":
      case "strictObject":
      case "looseObject":
        return { type: "object", shape: await this.shape(file, arg(0), depth) };
      case "array":
        return { type: "array", item: await child(arg(0)) };
      case "tuple": {
        const list = arg(0);
        const items =
          list && ts.isArrayLiteralExpression(unwrap(list))
            ? (unwrap(list) as TS.ArrayLiteralExpression).elements
            : [];
        return { type: "tuple", items: await Promise.all(items.map((item) => child(item))) };
      }
      case "record":
      case "partialRecord": {
        const keys = args.length > 1 ? await child(arg(0)) : undefined;
        const value = await child(args.length > 1 ? arg(1) : arg(0));
        const exhaustive = name === "record" && keys?.type === "enum";
        return { type: "record", keys: exhaustive ? keys.values : undefined, value };
      }
      case "union":
      case "xor":
      case "discriminatedUnion": {
        const list = args[args.length - 1];
        const options =
          list && ts.isArrayLiteralExpression(unwrap(list))
            ? (unwrap(list) as TS.ArrayLiteralExpression).elements
            : [];
        return {
          type: "union",
          options: await Promise.all(options.map((option) => child(option))),
        };
      }
      case "intersection":
        return intersect(await child(arg(0)), await child(arg(1)));
      case "optional":
        return { ...(await child(arg(0))), optional: true };
      case "nullable":
        return { ...(await child(arg(0))), nullable: true };
      case "nullish":
        return { ...(await child(arg(0))), optional: true, nullable: true };
      case "lazy": {
        const getter = arg(0) && unwrap(arg(0) as TS.Expression);
        const returned = getter && returnedExpression(getter);
        return returned ? child(returned) : unsupported(`z.lazy() on line ${lineOf(call)}`);
      }
      case "preprocess":
        return child(arg(1));
      case "date":
        return unsupported(
          "z.date() needs a Date object, which JSON cannot carry (z.coerce.date() accepts a string)",
        );
      case "bigint":
        return unsupported("z.bigint() needs a BigInt, which JSON cannot carry");
      case "map":
      case "set":
      case "promise":
      case "function":
      case "custom":
      case "instanceof":
      case "file":
      case "never":
      case "nan":
      case "symbol":
      case "templateLiteral":
        return unsupported(`z.${name}() on line ${lineOf(call)}`);
      default:
        if (STRING_FORMATS.has(name)) return { type: "string", format: name };
        return unsupported(`z.${name}() on line ${lineOf(call)}`);
    }
  }

  private async modifier(
    file: ParsedFile,
    base: ZodModel,
    method: string,
    call: TS.CallExpression,
    depth: number,
  ): Promise<ZodModel> {
    const args = call.arguments;
    const numberArg = numericValue(args[0]);
    const caveat = (text: string): ZodModel => ({
      ...base,
      caveats: [...(base.caveats ?? []), text],
    });

    switch (method) {
      case "optional":
        return { ...base, optional: true };
      case "nullable":
        return { ...base, nullable: true };
      case "nullish":
        return { ...base, optional: true, nullable: true };
      case "nonoptional":
        return { ...base, optional: false };
      case "default":
      case "prefault": {
        const value = literalValue(args[0]);
        return { ...base, optional: true, ...(value ? { fallback: value } : {}) };
      }
      case "transform":
      case "overwrite":
        return { ...base, transformed: true };
      case "refine":
      case "superRefine":
      case "check":
        return caveat(`custom rule (.${method}) on line ${lineOf(call)}`);
      case "pipe":
        return caveat(`.pipe() on line ${lineOf(call)}`);
      case "array":
        return { type: "array", item: base };
      case "or": {
        const other = args[0] && (await this.model(file, args[0], depth + 1));
        return { type: "union", options: other ? [base, other] : [base] };
      }
      case "and": {
        const other = args[0] && (await this.model(file, args[0], depth + 1));
        return other ? intersect(base, other) : base;
      }
    }

    if (base.type === "string") {
      if (method === "min" || method === "nonempty") return { ...base, min: numberArg ?? 1 };
      if (method === "max") return { ...base, max: numberArg };
      if (method === "length") return { ...base, length: numberArg };
      if (method === "startsWith" || method === "endsWith" || method === "includes") {
        return { ...base, [method]: stringValue(args[0]) ?? "" };
      }
      if (method === "uppercase") return { ...base, uppercase: true };
      if (method === "regex") {
        const regex = regexValue(args[0]);
        return regex
          ? { ...base, regex }
          : caveat(`a regex RouteLens cannot read on line ${lineOf(call)}`);
      }
      if (STRING_FORMATS.has(method)) return { ...base, format: method };
      if (method === "ip") return { ...base, format: "ipv4" };
      return base;
    }

    if (base.type === "number") {
      const bound = (inclusive: boolean): Bound | undefined =>
        numberArg === undefined ? undefined : { value: numberArg, inclusive };
      switch (method) {
        case "min":
        case "gte":
          return { ...base, min: bound(true) };
        case "gt":
          return { ...base, min: bound(false) };
        case "max":
        case "lte":
          return { ...base, max: bound(true) };
        case "lt":
          return { ...base, max: bound(false) };
        case "positive":
          return { ...base, min: { value: 0, inclusive: false } };
        case "nonnegative":
          return { ...base, min: { value: 0, inclusive: true } };
        case "negative":
          return { ...base, max: { value: 0, inclusive: false } };
        case "nonpositive":
          return { ...base, max: { value: 0, inclusive: true } };
        case "int":
        case "safe":
          return { ...base, int: method === "int" || base.int };
        case "multipleOf":
        case "step":
          return { ...base, multipleOf: numberArg };
        default:
          return base;
      }
    }

    if (base.type === "array") {
      if (method === "min" || method === "nonempty") return { ...base, min: numberArg ?? 1 };
      if (method === "max") return { ...base, max: numberArg };
      if (method === "length") return { ...base, min: numberArg, max: numberArg };
      return base;
    }

    if (base.type === "object") {
      switch (method) {
        case "extend":
        case "safeExtend":
          return {
            ...base,
            shape: mergeShapes(base.shape, await this.shape(file, args[0], depth)),
          };
        case "merge": {
          const other = args[0] && (await this.model(file, args[0], depth + 1));
          return other?.type === "object"
            ? { ...base, shape: mergeShapes(base.shape, other.shape) }
            : base;
        }
        case "pick":
        case "omit": {
          const keys = maskKeys(args[0]);
          if (!keys)
            return caveat(`.${method}() with keys RouteLens cannot read on line ${lineOf(call)}`);
          const keep = (key: string): boolean =>
            method === "pick" ? keys.has(key) : !keys.has(key);
          return { ...base, shape: base.shape.filter(([key]) => keep(key)) };
        }
        case "partial":
        case "required": {
          const keys = args[0] ? maskKeys(args[0]) : undefined;
          return {
            ...base,
            shape: base.shape.map(([key, value]) =>
              !keys || keys.has(key)
                ? [key, { ...value, optional: method === "partial" }]
                : [key, value],
            ),
          };
        }
        case "keyof":
          return { type: "enum", values: base.shape.map(([key]) => key) };
        default:
          return base;
      }
    }

    if (base.type === "enum" && (method === "extract" || method === "exclude")) {
      const list = literalValue(args[0]);
      if (!list || !Array.isArray(list.value)) return base;
      const picked = new Set(list.value);
      return {
        ...base,
        values: base.values.filter((value) =>
          method === "extract" ? picked.has(value) : !picked.has(value),
        ),
      };
    }

    return base;
  }

  /** Fields of `z.object({ ... })`, including `...Other.shape` spreads. */
  private async shape(
    file: ParsedFile,
    expression: TS.Expression | undefined,
    depth: number,
  ): Promise<Array<[string, ZodModel]>> {
    if (!expression) return [];
    let node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const binding = await this.project.resolveIdentifier(file, node);
      if (binding?.kind !== "value" || !ts.isObjectLiteralExpression(binding.node)) return [];
      file = binding.file;
      node = binding.node;
    }
    if (!ts.isObjectLiteralExpression(node)) return [];

    let fields: Array<[string, ZodModel]> = [];
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyNameText(property.name);
        const value = await this.model(file, property.initializer, depth + 1);
        if (key !== undefined)
          fields = mergeShapes(fields, [[key, value ?? unsupported(`field "${key}"`)]]);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const value = await this.model(file, property.name, depth + 1);
        fields = mergeShapes(fields, [
          [property.name.text, value ?? unsupported(`field "${property.name.text}"`)],
        ]);
      } else if (ts.isSpreadAssignment(property)) {
        // ...Base.shape
        const spread = unwrap(property.expression);
        const owner =
          ts.isPropertyAccessExpression(spread) && spread.name.text === "shape"
            ? spread.expression
            : undefined;
        const base = owner && (await this.model(file, owner, depth + 1));
        if (base?.type === "object") fields = mergeShapes(fields, base.shape);
      }
    }
    return fields;
  }

  private async enumModel(
    file: ParsedFile,
    expression: TS.Expression | undefined,
    call: TS.CallExpression,
  ): Promise<ZodModel> {
    const list = literalValue(expression);
    if (list && Array.isArray(list.value)) return { type: "enum", values: list.value };
    if (list && isPlainObject(list.value))
      return { type: "enum", values: Object.values(list.value) };

    if (expression && ts.isIdentifier(unwrap(expression))) {
      const binding = await this.project.resolveIdentifier(
        file,
        unwrap(expression) as TS.Identifier,
      );
      if (binding?.kind === "value") {
        const node = binding.node;
        const values = ts.isEnumDeclaration(node)
          ? enumMemberValues(node)
          : isExpression(node)
            ? (() => {
                const value = literalValue(node);
                return (
                  value &&
                  (Array.isArray(value.value)
                    ? value.value
                    : isPlainObject(value.value)
                      ? Object.values(value.value)
                      : undefined)
                );
              })()
            : undefined;
        if (values && values.length > 0) return { type: "enum", values };
      }
    }
    return unsupported(`enum values RouteLens cannot read on line ${lineOf(call)}`);
  }
}

/** Make a value that passes `model`, as far as RouteLens can tell. */
export function sampleOf(model: ZodModel, depth = 0): ZodSample {
  const caveats = model.caveats ?? [];
  if (model.fallback && !model.transformed) {
    return { value: model.fallback.value, exact: caveats.length === 0, notes: [...caveats] };
  }
  const inner = sampleOfShape(model, depth);
  return {
    value: inner.value,
    exact: inner.exact && caveats.length === 0,
    notes: [...caveats, ...inner.notes],
  };
}

function sampleOfShape(model: ZodModel, depth: number): ZodSample {
  const exact = (value: unknown): ZodSample => ({ value, exact: true, notes: [] });
  if (depth > MAX_DEPTH)
    return { value: null, exact: false, notes: ["the schema is nested too deep"] };

  switch (model.type) {
    case "string":
      return stringSample(model);
    case "number":
      return numberSample(model);
    case "boolean":
      return exact(true);
    case "null":
      return exact(null);
    case "undefined":
      return exact(undefined);
    case "any":
      return exact(null);
    case "literal":
      return exact(model.value);
    case "enum":
      return model.values.length > 0
        ? exact(model.values[0])
        : { value: null, exact: false, notes: ["an enum with no values"] };
    case "array": {
      const count = Math.min(Math.max(model.min ?? 0, 1), model.max ?? Number.POSITIVE_INFINITY);
      const item = sampleOf(model.item, depth + 1);
      if (!item.exact && (model.min ?? 0) === 0) return exact([]);
      return {
        value: Array.from({ length: count }, () => item.value),
        exact: item.exact,
        notes: item.notes,
      };
    }
    case "tuple": {
      const items = model.items.map((item) => sampleOf(item, depth + 1));
      return combine(
        items.map((item) => item.value),
        items,
      );
    }
    case "object": {
      const value: Record<string, unknown> = {};
      const parts: ZodSample[] = [];
      for (const [key, field] of model.shape) {
        const sample = sampleOf(field, depth + 1);
        // An optional field RouteLens cannot fill is left out: leaving it out is always valid.
        if (sample.value === undefined || (field.optional && !sample.exact)) continue;
        value[key] = sample.value;
        parts.push(sample);
      }
      return combine(value, parts);
    }
    case "record": {
      if (!model.keys) return exact({});
      const value: Record<string, unknown> = {};
      const parts = model.keys.map((key) => {
        const sample = sampleOf(model.value, depth + 1);
        value[String(key)] = sample.value;
        return sample;
      });
      return combine(value, parts);
    }
    case "union": {
      const samples = model.options.map((option) => sampleOf(option, depth + 1));
      return (
        samples.find((sample) => sample.exact) ??
        samples[0] ?? { value: null, exact: false, notes: ["an empty union"] }
      );
    }
    case "unsupported":
      return { value: null, exact: false, notes: [model.reason] };
  }
}

function combine(value: unknown, parts: ZodSample[]): ZodSample {
  return {
    value,
    exact: parts.every((part) => part.exact),
    notes: parts.flatMap((part) => part.notes),
  };
}

/** Example values for zod's string formats; each one passes zod 4's own check. */
const FORMAT_SAMPLES: Record<string, string> = {
  email: "user@example.com",
  url: "https://example.com",
  httpUrl: "https://example.com",
  uuid: "00000000-0000-4000-8000-000000000000",
  uuidv4: "00000000-0000-4000-8000-000000000000",
  uuidv6: "00000000-0000-6000-8000-000000000000",
  uuidv7: "00000000-0000-7000-8000-000000000000",
  guid: "00000000-0000-4000-8000-000000000000",
  cuid: "cjld2cjxh0000qzrmn831i7rn",
  cuid2: "tz4a98xxat96iws9zmbrgj3a",
  ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  nanoid: "V1StGXR8_Z5jdHi6B-myT",
  emoji: "👍",
  ipv4: "127.0.0.1",
  ipv6: "::1",
  cidrv4: "10.0.0.0/8",
  cidrv6: "::1/128",
  e164: "+14155550100",
  base64: "ZXhhbXBsZQ==",
  base64url: "ZXhhbXBsZQ",
  hex: "c0ffee",
  hostname: "example.com",
  datetime: "2026-01-01T00:00:00Z",
  date: "2026-01-01",
  time: "12:00:00",
  duration: "P1D",
};
/** `z.email()`, `z.string().email()`… (`z.date()` is a Date, handled before this is used). */
const STRING_FORMATS = new Set(Object.keys(FORMAT_SAMPLES));

function stringSample(model: Extract<ModelShape, { type: "string" }>): ZodSample {
  const notes: string[] = [];
  const formatted = model.format !== undefined;
  let value = (model.format && FORMAT_SAMPLES[model.format]) ?? "example";
  if (model.format && !FORMAT_SAMPLES[model.format])
    notes.push(`the string format "${model.format}"`);

  if (!formatted) {
    value = `${model.startsWith ?? ""}${value}${model.includes ?? ""}${model.endsWith ?? ""}`;
    const min = model.length ?? model.min;
    const max = model.length ?? model.max;
    if (min !== undefined && value.length < min) {
      const end = model.endsWith ?? "";
      value = value.slice(0, value.length - end.length).padEnd(min - end.length, "x") + end;
    }
    if (max !== undefined && value.length > max) value = value.slice(0, max);
    if (model.uppercase) value = value.toUpperCase();
  }

  const checks = [
    model.length === undefined || value.length === model.length,
    model.min === undefined || value.length >= model.min,
    model.max === undefined || value.length <= model.max,
    model.startsWith === undefined || value.startsWith(model.startsWith),
    model.endsWith === undefined || value.endsWith(model.endsWith),
    model.includes === undefined || value.includes(model.includes),
  ];
  if (checks.includes(false)) notes.push(`a string with rules that do not fit together (${value})`);
  if (model.regex && !model.regex.test(value)) notes.push(`the pattern ${String(model.regex)}`);
  return { value, exact: notes.length === 0, notes };
}

function numberSample(model: Extract<ModelShape, { type: "number" }>): ZodSample {
  const { min, max, int, multipleOf } = model;
  const above = (bound: Bound): number =>
    bound.inclusive
      ? int
        ? Math.ceil(bound.value)
        : bound.value
      : int
        ? Math.floor(bound.value) + 1
        : bound.value + 1;
  const below = (bound: Bound): number =>
    bound.inclusive
      ? int
        ? Math.floor(bound.value)
        : bound.value
      : int
        ? Math.ceil(bound.value) - 1
        : bound.value - 1;

  let value = min ? above(min) : 1;
  if (max && value > below(max))
    value = min ? (int ? below(max) : (min.value + max.value) / 2) : below(max);
  if (multipleOf) value = Math.ceil(value / multipleOf) * multipleOf;

  const fits =
    (!min || (min.inclusive ? value >= min.value : value > min.value)) &&
    (!max || (max.inclusive ? value <= max.value : value < max.value)) &&
    (!int || Number.isInteger(value));
  return fits
    ? { value, exact: true, notes: [] }
    : { value, exact: false, notes: ["a number with limits that do not fit together"] };
}

function intersect(left: ZodModel, right: ZodModel): ZodModel {
  if (left.type === "object" && right.type === "object") {
    return { ...left, shape: mergeShapes(left.shape, right.shape) };
  }
  return { ...left, caveats: [...(left.caveats ?? []), "an intersection of non-object schemas"] };
}

function mergeShapes(
  base: Array<[string, ZodModel]>,
  extra: Array<[string, ZodModel]>,
): Array<[string, ZodModel]> {
  const result = base.filter(([key]) => !extra.some(([other]) => other === key));
  return [...result, ...extra];
}

function unsupported(reason: string): ZodModel {
  return { type: "unsupported", reason };
}

function isZodModule(module: string): boolean {
  return module === "zod" || module.startsWith("zod/");
}

function isNamespaceName(name: string): boolean {
  return name === "*" || name === "default" || name === "z";
}

function isExpression(node: TS.Node): node is TS.Expression {
  return (
    !ts.isFunctionDeclaration(node) && !ts.isClassDeclaration(node) && !ts.isEnumDeclaration(node)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ a: true, b: true }` → {"a", "b"} (zod's `.pick()` / `.omit()` / `.partial()` masks). */
function maskKeys(expression: TS.Expression | undefined): Set<string> | undefined {
  const node = expression && unwrap(expression);
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const keys = new Set<string>();
  for (const property of node.properties) {
    const key =
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
        ? propertyNameText(property.name)
        : undefined;
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/** The value of a JSON-like literal written in the code (strings, numbers, arrays, objects). */
export function literalValue(
  expression: TS.Expression | undefined,
): { value: unknown } | undefined {
  if (!expression) return undefined;
  const node = unwrap(expression);
  const text = stringValue(node);
  if (text !== undefined) return { value: text };
  if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return { value: -Number(node.operand.text) };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      const value = literalValue(element);
      if (!value) return undefined;
      values.push(value.value);
    }
    return { value: values };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = propertyNameText(property.name);
      const inner = literalValue(property.initializer);
      if (key === undefined || !inner) return undefined;
      value[key] = inner.value;
    }
    return { value };
  }
  return undefined;
}

function numericValue(expression: TS.Expression | undefined): number | undefined {
  const value = literalValue(expression)?.value;
  return typeof value === "number" ? value : undefined;
}

function regexValue(expression: TS.Expression | undefined): RegExp | undefined {
  const node = expression && unwrap(expression);
  if (!node || !ts.isRegularExpressionLiteral(node)) return undefined;
  const match = /^\/(.*)\/([a-z]*)$/s.exec(node.text);
  try {
    return match ? new RegExp(match[1] ?? "", match[2]) : undefined;
  } catch {
    return undefined;
  }
}

function enumMemberValues(declaration: TS.EnumDeclaration): unknown[] {
  let next = 0;
  return declaration.members.map((member) => {
    const value = literalValue(member.initializer);
    if (value && typeof value.value === "number") next = value.value + 1;
    else if (!value) return next++;
    return value.value;
  });
}

/** The expression a `() => x` or `() => { return x; }` getter returns. */
function returnedExpression(node: TS.Expression): TS.Expression | undefined {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return undefined;
  if (!ts.isBlock(node.body)) return node.body;
  for (const statement of node.body.statements) {
    if (ts.isReturnStatement(statement)) return statement.expression;
  }
  return undefined;
}
