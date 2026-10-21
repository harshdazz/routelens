import { z } from "zod";
import { RouteLensError } from "./errors.js";
import { isResponsePath } from "./runner/valuePath.js";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods that must not carry a request body. */
export const METHODS_WITHOUT_BODY: readonly HttpMethod[] = ["GET", "HEAD"];

const stringMap = z.record(z.string(), z.string());

export const requestBodySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({
      type: z.literal("json"),
      content: z.unknown().describe("Any JSON value. Strings may contain {{variables}}."),
    }),
    z.object({ type: z.literal("text"), content: z.string() }),
    z.object({
      type: z.literal("form"),
      content: stringMap.describe("Sent as application/x-www-form-urlencoded."),
    }),
  ])
  .describe("Request body.");

export const routeLinkSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .describe('The route in your code this request was made from, e.g. "POST /api/posts/:id".'),
    file: z
      .string()
      .min(1)
      .optional()
      .describe("Where the route handler is, relative to the project root."),
    generated: stringMap
      .default({})
      .describe(
        "Fingerprints of the values RouteLens wrote. When the route changes, RouteLens updates a value only while it still matches its fingerprint, so your edits are kept. Leave these as they are.",
      ),
  })
  .describe("Set by RouteLens on requests it made from a route in your code.");

const VALUE_TYPES = ["string", "number", "boolean", "object", "array", "null"] as const;

const pathSchema = z
  .string()
  .refine(isResponsePath, {
    message:
      'Not a path into the response. Start with status, durationMs, headers or body, e.g. "body.items[0].id".',
  })
  .describe('A path into the response, e.g. "body.id", "body.items[0].name", "headers.location".');

export const matcherSchema = z
  .strictObject({
    equals: z.unknown().optional().describe("Equal to this value."),
    exists: z.boolean().optional().describe("true: the value is there; false: it is missing."),
    type: z.enum(VALUE_TYPES).optional(),
    contains: z
      .unknown()
      .optional()
      .describe(
        "A string contains this text, an array contains this item, or an object these fields.",
      ),
    matches: z
      .string()
      .refine(isRegExp, { message: "Not a valid regular expression." })
      .optional()
      .describe("A regular expression the value must match."),
    lessThan: z.number().optional(),
    greaterThan: z.number().optional(),
  })
  .refine((matcher) => Object.keys(matcher).length === 1, {
    message: "Use exactly one of equals, exists, type, contains, matches, lessThan, greaterThan.",
  })
  .describe('One check, e.g. { "type": "number" } or { "contains": "json" }.');

const statusCode = z.number().int().min(100).max(599);

export const expectSchema = z
  .strictObject({
    status: z
      .union([
        statusCode,
        z.array(statusCode).min(1),
        z
          .string()
          .regex(/^[1-5]xx$/, { message: 'Use a code (201), a list ([200, 201]) or "2xx".' }),
      ])
      .optional()
      .describe('A status code, a list of codes, or a class like "2xx".'),
    body: z
      .unknown()
      .optional()
      .describe(
        "The JSON response must contain these fields with these values. Objects may have more fields; arrays and other values must be equal.",
      ),
    values: z
      .record(
        pathSchema,
        z.union(
          [z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), matcherSchema],
          {
            error: 'Use a value to compare with, or one check such as { "type": "number" }.',
          },
        ),
      )
      .optional()
      .describe(
        'Path to an expected value or one check, e.g. { "body.id": { "type": "number" }, "body.title": "Hello" }.',
      ),
    maxDurationMs: z.number().positive().optional().describe("Fail when the response is slower."),
  })
  .describe(
    "What the response must look like. Values may use {{variables}}. Without expect, a request passes when the status is below 400.",
  );

/** The parts of a request that say what to send. Shared by request files and flow steps. */
const requestFields = {
  method: z.enum(HTTP_METHODS),
  url: z
    .string()
    .min(1)
    .describe("Full URL. May contain {{variables}}, e.g. {{baseUrl}}/api/posts."),
  headers: stringMap
    .default({})
    .describe("Header name to value. Values may contain {{variables}}."),
  query: stringMap.default({}).describe("Query parameters appended to the URL."),
  body: requestBodySchema.default({ type: "none" }),
};

export const requestSchema = z
  .object({
    version: z.literal(1).describe("File format version."),
    name: z.string().min(1).describe("Human-readable name shown in the UI."),
    description: z.string().optional(),
    ...requestFields,
    expect: expectSchema.optional(),
    route: routeLinkSchema.optional(),
  })
  .describe("A RouteLens request (.req.json).");

const variableNameSchema = z.string().regex(/^[A-Za-z_][\w.-]*$/, {
  message: "Variable names use letters, digits, _, . and - and start with a letter or _.",
});

export const flowStepSchema = z.strictObject({
  name: z.string().min(1).optional().describe("Shown in results. Default: the request's name."),
  request: z.union([
    z
      .string()
      .min(1)
      .describe(
        'A saved request: its file name in .routelens/requests without .req.json, e.g. "create-post".',
      ),
    z
      .strictObject({ name: z.string().min(1).optional(), ...requestFields })
      .describe("A request written in the step."),
  ]),
  extract: z
    .record(variableNameSchema, pathSchema)
    .default({})
    .describe('Values to keep for the next steps, e.g. { "postId": "body.id" } → {{postId}}.'),
  expect: expectSchema
    .optional()
    .describe(
      "What the response must look like. Default: the saved request's expect, else status below 400.",
    ),
});

export const flowSchema = z
  .object({
    version: z.literal(1).describe("File format version."),
    name: z.string().min(1),
    description: z.string().optional(),
    variables: stringMap
      .default({})
      .describe(
        "Starting values for this flow; they override the environment. No secrets: this file is committed.",
      ),
    steps: z
      .array(flowStepSchema)
      .min(1)
      .describe("Run in order. The first failing step stops the flow."),
  })
  .describe("A RouteLens flow (.flow.json): requests run in order, replayed with plain code.");

export const environmentSchema = z
  .object({
    version: z.literal(1).describe("File format version."),
    name: z.string().min(1),
    variables: stringMap
      .default({})
      .describe("Variable name to value. Do not put secrets here: this file is committed."),
  })
  .describe("A RouteLens environment (.env.json).");

/** A request after validation, with defaults filled in. */
export type ApiRequest = z.output<typeof requestSchema>;
/** A request as written in a file (optional fields may be missing). */
export type ApiRequestInput = z.input<typeof requestSchema>;
export type RequestBody = z.output<typeof requestBodySchema>;
export type RouteLink = z.output<typeof routeLinkSchema>;
export type Environment = z.output<typeof environmentSchema>;
/** What a response must look like (`expect` in requests and flow steps). */
export type Expectation = z.output<typeof expectSchema>;
export type Matcher = z.output<typeof matcherSchema>;
export type Flow = z.output<typeof flowSchema>;
export type FlowStep = z.output<typeof flowStepSchema>;
export type FlowInput = z.input<typeof flowSchema>;
/** An environment as written in a file (`variables` may be missing). */
export type EnvironmentInput = z.input<typeof environmentSchema>;

/** Parse JSON text and validate it with `schema`. Errors are RouteLensErrors safe to show. */
export function parseJsonFile<T>(schema: z.ZodType<T>, text: string, source: string): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RouteLensError("invalid-file", `${source} is not valid JSON: ${reason}`, {
      cause: error,
    });
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      // A bad record key (e.g. an expect path) says why in its inner issue.
      const message =
        issue.code === "invalid_key" && issue.issues[0] ? issue.issues[0].message : issue.message;
      return `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${message}`;
    });
    throw new RouteLensError(
      "invalid-file",
      `${source} has ${details.length} problem(s): ${details[0]}`,
      {
        cause: result.error,
        details,
      },
    );
  }
  return result.data;
}

/** Parse the text of a `.req.json` file. `source` is used in error messages. */
export function parseRequest(text: string, source = "Request file"): ApiRequest {
  return parseJsonFile(requestSchema, text, source);
}

/** Parse the text of a `.env.json` file. `source` is used in error messages. */
export function parseEnvironment(text: string, source = "Environment file"): Environment {
  return parseJsonFile(environmentSchema, text, source);
}

/** Parse the text of a `.flow.json` file. `source` is used in error messages. */
export function parseFlow(text: string, source = "Flow file"): Flow {
  return parseJsonFile(flowSchema, text, source);
}

/** JSON Schemas for editor autocomplete (shipped with the VS Code extension). */
export function fileJsonSchemas(): { request: unknown; environment: unknown; flow: unknown } {
  const options = { io: "input", target: "draft-7" } as const;
  return {
    request: z.toJSONSchema(requestSchema, options),
    environment: z.toJSONSchema(environmentSchema, options),
    flow: z.toJSONSchema(flowSchema, options),
  };
}

function isRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
