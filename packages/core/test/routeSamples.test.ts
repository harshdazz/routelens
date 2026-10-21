import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { scanRoutes } from "../src/index.js";
import { loadFixtureValue } from "./helpers/fixtureModule.js";

// M3 acceptance (docs/03-roadmap.md): "95%+ of fixture routes detected; a sample body passes
// the route's own zod validation." Detection is checked route by route in scan.test.ts;
// here every sample is checked against the real schema the route validates with.

const FIXTURES = ["next-app-routes", "next-pages-api", "express-routes"];
const EXPECTED_ROUTES = { "next-app-routes": 12, "next-pages-api": 10, "express-routes": 14 };
/** Routes that validate their body with zod, per fixture. */
const EXPECTED_SCHEMAS = { "next-app-routes": 4, "next-pages-api": 3, "express-routes": 3 };

describe("M3 acceptance", () => {
  it.each(FIXTURES)("%s: every sample body passes the route's own zod schema", async (name) => {
    const dir = fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
    const { routes } = await scanRoutes(dir);
    const withSchema = routes.filter((route) => route.body?.from === "zod");
    expect(withSchema).toHaveLength(EXPECTED_SCHEMAS[name as keyof typeof EXPECTED_SCHEMAS]);

    for (const route of withSchema) {
      const { schema, sample, exact } = route.body ?? {};
      if (!schema) throw new Error(`${route.key}: no schema location`);
      const real = loadFixtureValue(dir, schema.file, schema.name) as ZodType;
      // A real schema with required fields rejects an empty body (a stub would not).
      expect(real.safeParse({}).success, `${route.key}: ${schema.name} is not a real schema`).toBe(
        false,
      );
      const result = real.safeParse(sample);
      expect(
        result.success,
        `${route.key}: ${schema.name} rejected ${JSON.stringify(sample)}`,
      ).toBe(true);
      expect(exact, route.key).toBe(true);
    }
  });

  it("detects at least 95% of the fixture routes", async () => {
    let found = 0;
    let expected = 0;
    for (const name of FIXTURES) {
      const dir = fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
      found += (await scanRoutes(dir)).routes.length;
      expected += EXPECTED_ROUTES[name as keyof typeof EXPECTED_ROUTES];
    }
    expect(found / expected).toBeGreaterThanOrEqual(0.95);
  });
});
