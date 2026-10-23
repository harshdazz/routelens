import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileJsonSchemas } from "@routelens/core";

// The JSON Schemas in ../schemas give users autocomplete in .req.json / .env.json /
// .flow.json files.
// They are generated from the zod schemas in core. If this test fails, run:
//   UPDATE_SCHEMAS=1 pnpm --filter routelens-api-client test
const schemaFile = (name: string) => fileURLToPath(new URL(`../schemas/${name}`, import.meta.url));
const format = (schema: unknown) => `${JSON.stringify(schema, null, 2)}\n`;

describe("shipped JSON Schemas", () => {
  const schemas = fileJsonSchemas();
  const files = [
    ["request.schema.json", schemas.request],
    ["environment.schema.json", schemas.environment],
    ["flow.schema.json", schemas.flow],
  ] as const;

  for (const [name, schema] of files) {
    it(`${name} matches the zod schema`, async () => {
      if (process.env.UPDATE_SCHEMAS) {
        await writeFile(schemaFile(name), format(schema), "utf8");
      }
      expect(await readFile(schemaFile(name), "utf8")).toBe(format(schema));
    });
  }
});
