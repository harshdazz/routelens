import type { DetectedRoute, SkippedRoute } from "@routelens/core";

// Text for detected routes in the CodeLens and the Routes view. No `vscode` import, so it
// can be unit-tested.

/** `POST /api/posts/:id` */
export function routeLabel(route: DetectedRoute): string {
  return `${route.method} ${route.path}`;
}

/** The ▶ button above a route handler: `▶ Send POST /api/posts`. */
export function routeLensTitle(route: DetectedRoute): string {
  return `$(play) Send ${routeLabel(route)}`;
}

/** Hover text: where the route is, what body RouteLens will send and how sure it is. */
export function routeTooltip(route: DetectedRoute, draftFile?: string): string {
  const lines = [`${routeLabel(route)} · ${route.file}:${route.line}`];
  if (route.anyMethod) {
    lines.push(`This handler answers every method; RouteLens sends ${route.method}.`);
  }
  const body = route.body;
  if (body?.from === "zod") {
    const schema = body.schema
      ? ` ${body.schema.name} (${body.schema.file}:${body.schema.line})`
      : "";
    lines.push(`Sample body from the zod schema${schema}.`);
  } else if (body?.from === "fields") {
    lines.push("Sample body from the fields the handler reads (no zod schema).");
  }
  if (body && !body.exact) {
    lines.push(
      `The server may reject the sample: RouteLens could not check ${body.notes.join("; ")}.`,
    );
  }
  lines.push(
    draftFile ? `Request: ${draftFile}` : "RouteLens makes a request file when you click Send.",
  );
  return lines.join("\n");
}

/** `src/app.ts:18 · the path is not a plain string` */
export function skippedLabel(skipped: SkippedRoute): string {
  return `${skipped.file}:${skipped.line}`;
}

/** "Found 14 API routes" (with the frameworks it looked for when there are none). */
export function scanSummary(routeCount: number, frameworks: readonly string[]): string {
  if (frameworks.length === 0) {
    return "No Next.js or Express in package.json, so there are no routes to read yet.";
  }
  return routeCount === 1 ? "Found 1 API route." : `Found ${routeCount} API routes.`;
}
