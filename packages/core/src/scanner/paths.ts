/**
 * Route paths use one syntax for every framework, Express 5 style (ADR-0007):
 * `/api/posts/:id`, `/api/files/*path`, `/api/docs{/*slug}`.
 */

/** `/api` + `/users/` → `/api/users`. Always starts with `/`, never ends with one (except `/`). */
export function joinRoutePath(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment !== "")
    .join("/");
  return `/${joined}`;
}

/**
 * The URL path of a Next.js file-system route, from its folder names below `app/` or
 * `pages/`. `undefined` when Next.js would not route it.
 * - `[id]` → `:id`, `[...slug]` → `*slug`, `[[...slug]]` → `{/*slug}`
 * - App Router only: `(group)` and `@slot` folders are not part of the URL, and private
 *   `_folders` are not routed at all
 */
export function nextRoutePath(
  segments: readonly string[],
  router: "app" | "pages" = "app",
): string | undefined {
  const parts: string[] = [];
  let optionalTail = "";
  for (const segment of segments) {
    if (router === "app") {
      if (segment.startsWith("_")) return undefined;
      if ((segment.startsWith("(") && segment.endsWith(")")) || segment.startsWith("@")) continue;
    }
    const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
    const dynamic = /^\[(.+)\]$/.exec(segment);
    if (optionalCatchAll?.[1]) optionalTail = `{/*${optionalCatchAll[1]}}`;
    else if (catchAll?.[1]) parts.push(`*${catchAll[1]}`);
    else if (dynamic?.[1]) parts.push(`:${dynamic[1]}`);
    else parts.push(segment);
  }
  const base = joinRoutePath(...parts);
  return optionalTail ? `${base === "/" ? "" : base}${optionalTail}` : base;
}

/** The names of the parameters in a route path: `/users/:id/*rest` → `["id", "rest"]`. */
export function routeParams(routePath: string): string[] {
  return [...routePath.matchAll(/[:*]([A-Za-z_$][\w$]*)/g)].map((match) => match[1] ?? "");
}

/**
 * A path you can send, with an example value for each parameter: ids get `1`, other
 * parameters `example`, and optional parts are left out. `/posts/:id` → `/posts/1`.
 */
export function samplePath(routePath: string): string {
  const withoutOptional = routePath.replace(/\{[^{}]*\}/g, "").replace(/\/:[\w$]+\?/g, "");
  const filled = withoutOptional.replace(
    /([:*])([A-Za-z_$][\w$]*)/g,
    (_match, kind, name: string) => (kind === ":" && /id$/i.test(name) ? "1" : "example"),
  );
  return filled === "" ? "/" : filled;
}

/** Identity of a route: `POST /api/posts/:id`. */
export function routeKey(method: string, routePath: string): string {
  return `${method} ${routePath}`;
}
