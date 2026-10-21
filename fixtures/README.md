# Fixtures

Small fake projects used by the tests in `packages/core/test/`. Each one is the smallest project that shows the patterns RouteLens must understand.

## Zero setup (M2, `detect.test.ts`)

Each one shows one way a real app tells us where its server runs.

| Fixture        | What it shows                               | Expected address        | Clue used                   | Package manager | Script  |
| -------------- | ------------------------------------------- | ----------------------- | --------------------------- | --------------- | ------- |
| `next-default` | Next.js with no port flag                   | `http://localhost:3000` | `next dev` default port     | npm             | `dev`   |
| `next-port`    | Next.js with `-p 3001`                      | `http://localhost:3001` | the `-p` flag in the script | yarn            | `dev`   |
| `vite`         | Vite with no config                         | `http://localhost:5173` | `vite` default port         | bun             | `dev`   |
| `express-env`  | Express with `PORT=4100` in `.env`          | `http://localhost:4100` | `.env` (beats `server.js`)  | pnpm            | `start` |
| `monorepo`     | pnpm workspace with `apps/api` + `apps/web` | `http://localhost:8080` | `listen()` in `apps/api`    | pnpm (root)     | `dev`   |

Notes:

- Only `next-default` has a real lockfile, so it can be installed (`npm ci`) for the end-to-end acceptance test. The other lockfiles are stubs: detection only looks at the file name.
- No fixture has `node_modules` committed. Detection never runs or imports project code; it only reads `package.json`, `.env` files, lockfiles and a few entry files as text.
- `.routelens/` folders that RouteLens creates inside a fixture while you try it by hand are ignored by Git.

## Reads your code (M3, `scan.test.ts`, `routeSamples.test.ts`)

| Fixture           | Routes | What it shows                                                                                                                                                                                                                                        |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next-app-routes` | 12     | App Router in `src/app`: exported functions and consts, `withAuth(…)` wrappers, `export { handler as GET }`, a re-export, `(group)` and `_private` folders, `[id]`, `[...path]` and `[[...slug]]`, a `.js` route, `@/` path aliases (JSONC tsconfig) |
| `next-pages-api`  | 10     | `pages/api`: `switch (req.method)`, `if (req.method === …)`, `!==` guards, handlers without checks (GET, or POST when they read a body), `[...nextauth]`, `index.ts`                                                                                 |
| `express-routes`  | 14     | ESM and CommonJS routers mounted across files, `router.route().get().put()`, `app.all`, `registerHealth(app)`, `validate(Schema)` middleware, `.partial().extend()`; traps: a regex path, an axios client, a test file                               |

Every route that validates its body with zod has a sample that passes that exact schema: `routeSamples.test.ts` loads the real schema from the fixture (with the real zod) and checks it. RouteLens itself never runs fixture code.
