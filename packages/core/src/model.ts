import { z } from "zod";
import { RouteLensError } from "./errors.js";

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

export const requestSchema = z
  .object({
    version: z.literal(1).describe("File format version."),
    name: z.string().min(1).describe("Human-readable name shown in the UI."),
    description: z.string().optional(),
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
    route: routeLinkSchema.optional(),
  })
  .describe("A RouteLens request (.req.json).");

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
    const details = result.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    );
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

/** JSON Schemas for editor autocomplete (shipped with the VS Code extension). */
export function fileJsonSchemas(): { request: unknown; environment: unknown } {
  const options = { io: "input", target: "draft-7" } as const;
  return {
    request: z.toJSONSchema(requestSchema, options),
    environment: z.toJSONSchema(environmentSchema, options),
  };
}
