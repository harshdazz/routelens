# See every route

RouteLens reads your code to find your API routes. It never runs your code, so it is safe in any project.

It understands:

- **Next.js App Router:** `app/**/route.ts` (and `src/app`), one route per exported `GET`, `POST`…
- **Next.js Pages API:** `pages/api/**`, with methods from your `req.method` checks
- **Express:** `app.get()`, `router.post()`, `router.route()` and routers mounted with `app.use("/api", router)`, across files

For each route you get:

- a **▶ Send** button above the handler, with the last result next to it (`✓ 201 Created · 14 ms`)
- a request file in `.routelens/requests/`, with a **sample body** made from the route's zod schema

When you change a route, its request updates by itself. Anything you edited in the request stays as you left it.

Something missing? It shows up under **Could not read** in the Routes view, with the reason.
