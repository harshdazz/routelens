# Fixtures

Small fake projects used by the tests in `packages/core/test/detect.test.ts` (M2, zero setup). Each one is the smallest project that shows one way a real app tells us where its server runs.

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
