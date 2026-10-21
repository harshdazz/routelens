import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { SourceProject, type ParsedFile } from "../src/scanner/project.js";
import { loadTypeScript, ts } from "../src/scanner/ts.js";
import { zodSample, type ZodSample } from "../src/scanner/zod.js";

/** Every case is read by RouteLens from source text, then checked against the real zod. */
const EXACT_CASES = [
  "z.string()",
  "z.string().min(10)",
  "z.string().max(3)",
  "z.string().length(12)",
  "z.string().min(2).max(4)",
  'z.string().startsWith("usr_").endsWith("!")',
  'z.string().includes("@")',
  "z.string().uppercase()",
  "z.string().regex(/^[a-z]+$/)",
  "z.string().trim().toLowerCase()",
  "z.string().email()",
  "z.email()",
  "z.url()",
  "z.string().url()",
  "z.httpUrl()",
  "z.uuid()",
  "z.uuidv4()",
  "z.uuidv7()",
  "z.guid()",
  "z.cuid()",
  "z.cuid2()",
  "z.ulid()",
  "z.nanoid()",
  "z.ipv4()",
  "z.ipv6()",
  "z.cidrv4()",
  "z.cidrv6()",
  "z.e164()",
  "z.base64()",
  "z.base64url()",
  "z.emoji()",
  "z.hex()",
  "z.hostname()",
  "z.iso.datetime()",
  "z.iso.date()",
  "z.iso.time()",
  "z.iso.duration()",
  "z.string().datetime()",
  "z.string().date()",
  "z.number()",
  "z.number().int().positive()",
  "z.number().min(5).max(10)",
  "z.number().gt(0).lt(1)",
  "z.number().negative()",
  "z.number().nonnegative()",
  "z.number().multipleOf(7).min(10)",
  "z.number().int().min(1.5)",
  "z.number().max(-3)",
  "z.int()",
  "z.uint32()",
  "z.float32()",
  "z.boolean()",
  "z.null()",
  'z.literal("x")',
  "z.literal(42)",
  'z.literal(["a", "b"])',
  'z.enum(["a", "b"])',
  "z.enum(Colors)",
  "z.nativeEnum(Role)",
  'z.enum(["a", "b", "c"]).exclude(["a"])',
  'z.enum(["a", "b", "c"]).extract(["c"])',
  "z.stringbool()",
  "z.array(z.string())",
  "z.array(z.number()).min(3)",
  "z.string().array().max(0)",
  "z.array(z.string()).nonempty()",
  "z.array(z.string()).length(2)",
  "z.tuple([z.string(), z.number()])",
  "z.object({ a: z.string(), b: z.number().optional() })",
  "z.strictObject({ a: z.string() })",
  "z.object({ a: z.string() }).extend({ b: z.boolean() })",
  "z.object({ a: z.string(), b: z.string() }).pick({ a: true }).strict()",
  "z.object({ a: z.string(), b: z.string() }).omit({ b: true }).strict()",
  "z.object({ a: z.string(), b: z.string() }).partial({ a: true })",
  "z.object({ a: z.string().optional() }).required()",
  "z.object({ a: z.string() }).merge(z.object({ b: z.number() }))",
  "z.object({ ...Base.shape, c: z.string() })",
  "z.object({ a: z.string() }).keyof()",
  "z.object({ when: z.date().optional(), name: z.string() })",
  "z.record(z.string(), z.number())",
  'z.record(z.enum(["x", "y"]), z.boolean())',
  'z.partialRecord(z.enum(["x"]), z.string())',
  "z.union([z.number(), z.string()])",
  "z.string().or(z.number())",
  'z.discriminatedUnion("kind", [z.object({ kind: z.literal("a") }), z.object({ kind: z.literal("b"), n: z.number() })])',
  "z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))",
  "z.object({ a: z.string() }).and(z.object({ b: z.number() }))",
  "z.string().optional()",
  "z.string().nullable()",
  "z.string().nullish()",
  "z.optional(z.string())",
  "z.nullable(z.number())",
  'z.string().default("hi")',
  "z.number().int().min(1).max(5).default(3)",
  "z.array(z.string()).default([])",
  "z.string().transform((value) => value.length).default(3)",
  "z.coerce.number()",
  "z.coerce.boolean()",
  "z.coerce.date()",
  "z.coerce.string()",
  "z.lazy(() => z.string())",
  "z.preprocess((value) => value, z.string())",
  'z.string().min(1).describe("x").meta({ title: "X" })',
  "z.any()",
  "z.unknown()",
];

/** Rules RouteLens cannot check: the sample is still made, but marked "not exact". */
const INEXACT_CASES = [
  "z.string().regex(/^\\d{3}$/)",
  "z.string().refine((value) => value.length > 100)",
  "z.string().pipe(z.string().min(3))",
  "z.date()",
  "z.bigint()",
  "z.string().min(5).max(2)",
];

const PRELUDE_TS = [
  'import { z } from "zod";',
  "const Base = z.object({ a: z.string() });",
  'const Colors = ["red", "green"] as const;',
  'enum Role { Admin = "admin", User = "user" }',
];

/** The same prelude for the real zod, as plain JavaScript. */
function realSchema(code: string): z.ZodType {
  const build = new Function(
    "z",
    `const Base = z.object({ a: z.string() });
     const Colors = ["red", "green"];
     const Role = { Admin: "admin", User: "user" };
     return (${code});`,
  ) as (zod: typeof z) => z.ZodType;
  return build(z);
}

let dir: string;
let project: SourceProject;
let file: ParsedFile;
const all = [...EXACT_CASES, ...INEXACT_CASES];

beforeAll(async () => {
  await loadTypeScript();
  dir = await mkdtemp(path.join(tmpdir(), "routelens-zod-"));
  const source = [
    ...PRELUDE_TS,
    ...all.map((code, index) => `export const s${index} = ${code};`),
  ].join("\n");
  await writeFile(path.join(dir, "schemas.ts"), source);
  await writeFile(
    path.join(dir, "named.ts"),
    [
      'import { object, string, number } from "zod";',
      'import * as v from "zod";',
      "export const named = object({ a: string().min(2), b: number().int() });",
      "export const namespaced = v.object({ c: v.email() });",
    ].join("\n"),
  );
  project = SourceProject.open(dir);
  const parsed = await project.file(path.join(dir, "schemas.ts"));
  if (!parsed) throw new Error("could not parse the test file");
  file = parsed;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sampleFor(target: ParsedFile, name: string): Promise<ZodSample | undefined> {
  const binding = await project.resolveName(target, name);
  if (binding?.kind !== "value" || !ts.isCallExpression(binding.node)) return undefined;
  return zodSample(project, binding.file, binding.node);
}

describe("zodSample", () => {
  it.each(EXACT_CASES.map((code, index) => [code, index] as const))(
    "%s → a sample the real zod accepts",
    async (code, index) => {
      const sample = await sampleFor(file, `s${index}`);
      expect(sample, code).toBeDefined();
      expect(sample?.notes).toEqual([]);
      expect(sample?.exact).toBe(true);
      const result = realSchema(code).safeParse(sample?.value);
      expect(
        result.success,
        `${code} rejected ${JSON.stringify(sample?.value)}: ${result.error?.message}`,
      ).toBe(true);
    },
  );

  it.each(INEXACT_CASES.map((code, index) => [code, EXACT_CASES.length + index] as const))(
    "%s → marked not exact, with a reason",
    async (code, index) => {
      const sample = await sampleFor(file, `s${index}`);
      expect(sample?.exact).toBe(false);
      expect(sample?.notes.length).toBeGreaterThan(0);
    },
  );

  it("gives readable samples", async () => {
    const valueOf = async (code: string): Promise<unknown> =>
      (await sampleFor(file, `s${all.indexOf(code)}`))?.value;
    expect(await valueOf("z.object({ a: z.string(), b: z.number().optional() })")).toEqual({
      a: "example",
      b: 1,
    });
    expect(await valueOf("z.number().int().min(1).max(5).default(3)")).toBe(3);
    expect(await valueOf('z.record(z.enum(["x", "y"]), z.boolean())')).toEqual({
      x: true,
      y: true,
    });
    expect(await valueOf("z.object({ when: z.date().optional(), name: z.string() })")).toEqual({
      name: "example",
    });
    expect(await valueOf("z.nativeEnum(Role)")).toBe("admin");
  });

  it("reads named zod imports and other namespace names", async () => {
    const named = await project.file(path.join(dir, "named.ts"));
    if (!named) throw new Error("could not parse named.ts");
    expect(await sampleFor(named, "named")).toEqual({
      value: { a: "example", b: 1 },
      exact: true,
      notes: [],
    });
    expect((await sampleFor(named, "namespaced"))?.value).toEqual({ c: "user@example.com" });
  });

  it("says when something is not a zod schema", async () => {
    await writeFile(path.join(dir, "other.ts"), "export const notZod = Math.max(1, 2);\n");
    const other = await project.file(path.join(dir, "other.ts"));
    if (!other) throw new Error("could not parse other.ts");
    expect(await sampleFor(other, "notZod")).toBeUndefined();
  });
});
