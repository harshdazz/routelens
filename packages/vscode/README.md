# RouteLens for VS Code

**The API client that reads your code.**

> Pre-alpha. Not on the Marketplace yet.

## Features (today)

- **Zero setup.** Open a JavaScript project and RouteLens finds your API's address (from your `dev` script, `.env` or server code), creates `.routelens/` with a first request, and tells you which clue it used, with a **Change** button.
- **Starts your server.** Click **▶ Send request** while your server is off and RouteLens offers **▶ Start server**. It runs your `dev` (or `start`) script in a visible terminal, waits up to 60 seconds, and sends the request again. Crashes are reported, with the terminal one click away.
- **Inline results.** `✓ 201 Created · 14 ms` next to the button. Hover for a body preview; click for the full response (status, time, size, headers, pretty body).
- **Environments** in the status bar, with `{{variables}}` from `.routelens/environments/<name>.env.json`.
- Requests are `.routelens/requests/*.req.json` files in your repo, with autocomplete. **RouteLens: New Request** creates one.
- A **Get Started** walkthrough.

## Commands

| Command                               | What it does                                          |
| ------------------------------------- | ----------------------------------------------------- |
| RouteLens: Send Request               | Send the open `.req.json` file                        |
| RouteLens: New Request                | Create a request file                                 |
| RouteLens: Set Up Project             | Find your API and create `.routelens/`                |
| RouteLens: Change Server Address      | Pick or type the address saved in `local.env.json`    |
| RouteLens: Start Server / Stop Server | Run or stop your `dev` / `start` script in a terminal |
| RouteLens: Select Environment         | Switch environments (also in the status bar)          |

## Settings

| Setting                     | Default | What it does                                                                    |
| --------------------------- | ------- | ------------------------------------------------------------------------------- |
| `routelens.environment`     | `local` | Default environment; the status bar picker overrides it for this workspace      |
| `routelens.timeoutMs`       | `30000` | Request timeout in milliseconds                                                 |
| `routelens.autoStartServer` | `ask`   | When your local server is off: `ask` to start it, start it `always`, or `never` |

## Safety

- Sending requests and starting servers only work in trusted workspaces.
- RouteLens only runs the `dev` (or `start`) script from your `package.json`, never a command from a `.routelens` file, and always in a terminal you can see.
- The first server start in each workspace always needs your click, even with `autoStartServer` set to `always`.
- `.routelens/` files are committed to Git: never put secrets in them.

## Coming next

Route detection for Next.js and Express, a "▶ Send" button above your route handlers, AI-generated test flows and failure explanations. See the [roadmap](https://github.com/harshdazz/routelens/blob/main/docs/03-roadmap.md).
