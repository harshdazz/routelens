import { describe, expect, it } from "vitest";
import type { DetectedRoute } from "@routelens/core";
import { routeLabel, routeLensTitle, routeTooltip, scanSummary } from "../src/routeText";

const route: DetectedRoute = {
  key: "POST /api/users",
  method: "POST",
  path: "/api/users",
  anyMethod: false,
  framework: "next-app",
  file: "app/api/users/route.ts",
  line: 12,
  body: {
    sample: { username: "example" },
    exact: true,
    from: "zod",
    schema: { name: "CreateUser", file: "lib/schemas.ts", line: 3 },
    notes: [],
  },
};

describe("route text", () => {
  it("labels a route by method and path", () => {
    expect(routeLabel(route)).toBe("POST /api/users");
    expect(routeLensTitle(route)).toBe("$(play) Send POST /api/users");
  });

  it("explains where the route and its sample body come from", () => {
    expect(routeTooltip(route, ".routelens/requests/post-api-users.req.json")).toBe(
      [
        "POST /api/users · app/api/users/route.ts:12",
        "Sample body from the zod schema CreateUser (lib/schemas.ts:3).",
        "Request: .routelens/requests/post-api-users.req.json",
      ].join("\n"),
    );
  });

  it("says honestly when the sample may be rejected, and when the handler takes any method", () => {
    const unsure: DetectedRoute = {
      ...route,
      anyMethod: true,
      body: { sample: {}, exact: false, from: "fields", notes: ["the pattern /^[A-Z]{3}$/"] },
    };
    const tooltip = routeTooltip(unsure);
    expect(tooltip).toContain("This handler answers every method; RouteLens sends POST.");
    expect(tooltip).toContain("Sample body from the fields the handler reads (no zod schema).");
    expect(tooltip).toContain(
      "The server may reject the sample: RouteLens could not check the pattern /^[A-Z]{3}$/.",
    );
    expect(tooltip).toContain("RouteLens makes a request file when you click Send.");
  });

  it("summarizes a scan", () => {
    expect(scanSummary(14, ["express"])).toBe("Found 14 API routes.");
    expect(scanSummary(1, ["next-app"])).toBe("Found 1 API route.");
    expect(scanSummary(0, [])).toBe(
      "No Next.js or Express in package.json, so there are no routes to read yet.",
    );
  });
});
