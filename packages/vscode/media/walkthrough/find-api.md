# Find your API

When you open a project, RouteLens looks for your API's address with plain code. No AI, and nothing is run. It checks, in this order:

1. a server that is **already running** on one of the ports below
2. a port written in your `dev` script, like `next dev -p 3001`
3. `PORT=` in `.env.local` or `.env`
4. the default port of your dev server (`next dev` uses 3000, `vite` uses 5173)
5. `app.listen(4000)` in your server code

It saves the address in `.routelens/environments/local.env.json` as `baseUrl`, creates a first request, and tells you which clue it used.

Wrong guess? Click **Change** on the message, or run **RouteLens: Change Server Address**.
