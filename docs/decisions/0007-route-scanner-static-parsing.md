# ADR-0007: The route scanner reads code with the TypeScript parser and never runs it

- Status: Accepted
- Date: 2026-10-21

## Context

M3 ("Reads your code") has to list the API routes of a project (Next.js App Router, Next.js Pages API, Express), make a draft request for each one with a valid sample body when the route validates its body with zod, and keep those drafts up to date when the code changes, without losing what the user typed.

Ways to find routes:

1. **Run the user's app** and ask Express for its router table. Exact, but it runs the user's code (database connections, side effects), needs their dependencies installed, and is not allowed in untrusted workspaces.
2. **Regular expressions** over the source. Small, but they break on comments, line breaks and imports.
3. **A real parser.** Options: the TypeScript compiler API, ts-morph (a wrapper around it), `@babel/parser`, or native parsers (oxc, swc). Native parsers need one binary per platform inside the `.vsix`.

## Decision

1. **Parse with the TypeScript compiler API, syntax only** (`createSourceFile`: no type checker, no `Program`). It reads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs`, the same way the user's own build does. It also gives us `resolveModuleName` and tsconfig parsing for free, so `@/lib/schemas` path aliases and `./users.js` → `users.ts` imports resolve like they do in the project.
   - Not ts-morph: we need neither its project model nor its code editing, and it would add a second copy of TypeScript.
   - TypeScript is about 3.5 MB minified and takes about 0.3 s to load, so it is **loaded on the first scan, not on activation**.
2. **Never execute user code.** zod schemas are read from the syntax tree and turned into a sample value by a small interpreter for the common zod calls (`z.object`, `z.string().email()`, `.min()`, `.optional()`, `.extend()`, unions, arrays, enums…). Optional fields are included when RouteLens can produce a valid value for them. When something cannot be modelled (a custom `.refine()`, a regex the sample does not match, `z.date()` in JSON), the sample is still produced and marked `exact: false`.
3. **Supported patterns** (each one has a fixture in `fixtures/`):
   - Next.js App Router: `app/**/route.(ts|js)` and `src/app/**`, exported `GET`/`POST`/… as functions, consts, wrapped handlers (`withAuth(…)`), `export { handler as GET }` and re-exports from other files. Route groups `(admin)` and private folders `_lib` follow Next.js rules. `basePath` from `next.config.*` is added.
   - Next.js Pages API: `pages/api/**` and `src/pages/api/**`. Methods come from `req.method` checks (`===`, `!==`, `switch`, `.includes`). A handler without checks answers every method; it gets `POST` if it reads a body, else `GET`.
   - Express: `app.get/post/put/patch/delete/all(path, …)`, `router.route(path).get(…).post(…)`, routers from `express.Router()` / `Router()`, `app.use(prefix, router)` across files (ESM and CommonJS), and functions that receive the app (`registerRoutes(app)`). Regex paths are skipped and reported.
   - Body schemas: `Schema.parse(…)` / `safeParse(…)` inside the handler, or a zod schema passed to a middleware (`validate(CreateUser)`). Without a schema, keys destructured from `req.body` / `await request.json()` give a body skeleton.
4. **One path syntax for every framework**, Express 5 style: `[id]` → `:id`, `[...slug]` → `*slug`, `[[...slug]]` → `{/*slug}`. A route's identity is its method plus that path (`POST /api/posts/:id`).
5. **Drafts are normal request files** (`.routelens/requests/post-api-posts-id.req.json`) with a `route` field: the route key, the source file, and short **fingerprints of the values RouteLens wrote** (`name`, `url`, and each top-level key of a JSON body). When the route changes, RouteLens replaces a value only while it still matches its fingerprint. A value the user edited no longer matches, so it is kept. A body key the user deleted is not added back, and a key the user added stays.
   - A route that disappears while another one with the same method appears in the same file is treated as a rename: the draft moves with it.
   - Drafts are only created for routes RouteLens has not seen before in this workspace (remembered in VS Code's workspace state). If the user deletes a draft, it does not come back by itself; clicking ▶ Send on the route makes it again.
6. **Monorepos:** RouteLens scans the package that `detect` picked as the API server (ADR-0006). Other packages are not scanned yet.
7. **Workspace trust:** scanning only reads files, so the routes tree and the ▶ Send CodeLens also appear in untrusted workspaces. Writing drafts and sending requests need trust.

## Why

- A parser is the only option that is both safe (no code runs) and robust (comments, formatting, imports). Using the same parser as the user's build means no surprises with TypeScript-only syntax.
- Fingerprints make "update what RouteLens wrote, keep what the user wrote" work without a hidden database. They live in the file, so they work for every teammate who clones the repo and are visible in code review.
- Showing `exact: false` and skipped routes keeps the automation honest, like the "from …" clue in ADR-0006.

## Consequences

- `typescript` becomes a runtime dependency of `packages/core` (pinned to the same minor as the build). The extension bundle grows by about 3.5 MB.
- Request files made from routes carry a `route` field. Its JSON Schema description explains the fingerprints, so a reader knows not to edit them.
- Patterns outside the list above are missed: routes built in loops, paths in variables from other files, Fastify, Hono and NestJS (parked in the roadmap). The fixtures and the 95% detection target keep this measurable.
- The zod interpreter follows zod 4 (zod 3 calls with the same names also work). New zod features need new cases in its tests, which check every sample against the real zod.
