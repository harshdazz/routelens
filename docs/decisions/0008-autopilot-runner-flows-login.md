# ADR-0008: Autopilot: one runner for requests and flows, checks in the files, auto-login

- Status: Accepted
- Date: 2026-10-21

## Context

M4 makes RouteLens test the API by itself: "Test everything" runs every route, saving a route file runs its requests again, protected routes log in by themselves, and the same tests run in CI with `routelens run`. Four things had to be decided:

1. Where the "did it pass?" rules live.
2. What a flow (`.flow.json`, [ADR-0003](0003-request-file-format.md), [ADR-0004](0004-ai-writes-once-replay-deterministic.md)) looks like.
3. How auto-login works without secrets in `.routelens/`.
4. How the CLI is shipped next to the extension.

## Decision

**One runner in core** (`packages/core/src/runner/`). The extension, the CLI and later the MCP server all call `runRequest` and `runFlow`. They never decide pass or fail themselves.

**Checks live in the files, in an optional `expect` block.** It works the same on a request and on a flow step:

```json
"expect": {
  "status": 201,
  "body": { "title": "Hello" },
  "values": { "body.id": { "type": "number" }, "headers.content-type": { "contains": "json" } },
  "maxDurationMs": 2000
}
```

- `status`: a code, a list of codes, or a class (`"2xx"`).
- `body`: the JSON response must contain these fields with these values. Objects are matched partially, while arrays and other values must be equal.
- `values`: maps a path to an expected value. A plain value means "equals". An object is a matcher, one of `equals`, `exists`, `type`, `contains`, `matches`, `lessThan`, `greaterThan`.
- Paths look like `status`, `durationMs`, `headers.<name>`, `body`, `body.items[0].id`, `body.items.length`, `body["odd-key"]`.
- Without `expect`, a request passes when the status is below 400, the same rule as the inline ✓/✗ (M2).

**Flows** are a list of steps:

```json
{
  "version": 1,
  "name": "Create and read a post",
  "steps": [
    { "request": "create-post", "extract": { "postId": "body.id" }, "expect": { "status": 201 } },
    {
      "name": "Read it",
      "request": { "method": "GET", "url": "{{baseUrl}}/api/posts/{{postId}}" },
      "expect": { "values": { "body.id": "{{postId}}" } }
    }
  ]
}
```

- A step's `request` is either the name of a saved request (its file name in `.routelens/requests/` without `.req.json`) or an inline request.
- `extract` saves values from the response for the following steps.
- When a whole JSON string is one placeholder (`"{{postId}}"`), the extracted value is used with its type, so `2` stays a number. Elsewhere it is turned into text.
- Variables are looked up in this order: the environment, then the flow's own `variables`, then extracted values. Each one overrides the one before.
- Steps run one after another, and the first failing step stops the flow, because later steps usually need its values.

**Auto-login** ("log in once, reuse the token"):

- Core finds the login request among the request files: a `POST` to `/login`, `/signin`, `/auth/login`, `/session`, `/token` and the like, with a password field in its body.
- When a request to the same server gets a `401`, the runner logs in, saves the token and sends the request again, once.
- The token is either a token-like field in the JSON response (`token`, `accessToken`, `access_token`, `jwt`, `idToken`…, up to 3 levels deep), sent as `Authorization: Bearer …`, or the response's cookies, sent as `Cookie`.
- The token is only added to requests to the same origin as the login request, and never when the request already has that header.
- A request whose `expect.status` includes `401` is never logged in or retried, so "no token → 401" tests keep working.
- Credentials come from the person, never from files:
  - In VS Code, the username and password are asked once and kept in `SecretStorage` (the OS keychain). The token stays in memory. "RouteLens: Log Out" forgets both.
  - In the CLI, they come from the environment variables `ROUTELENS_USERNAME` and `ROUTELENS_PASSWORD` (GitHub Actions secrets).

**CLI**: a new package `@routelens/cli` with the command `routelens`.

- `routelens run [folder]` runs the saved requests, then the flows.
- Options: `--env`, `--var name=value`, `--junit <file>`, `--start` (start the `dev`/`start` script when the server is off, like zero setup), `--wait <s>`.
- Variables named `ROUTELENS_VAR_<name>` in the environment fill `{{name}}`. That is how CI passes secrets.
- The exit code is 0 when everything passed, 1 when something failed, and 2 when the run could not start.
- It is bundled with esbuild, so the published package has no workspace dependency. TypeScript is not bundled, because the CLI does not scan code.

**Running order** for "Test everything": `GET`/`HEAD`/`OPTIONS` first, then `POST`, `PUT`, `PATCH`, and `DELETE` last, so a delete doesn't break a read. Flows run after the requests. Everything runs one at a time, so results are the same on every run. When the environment is not this machine and the run includes writes, VS Code asks first.

**Watch mode**:

- Saving a file with route handlers rescans it first, so the drafts are updated. Then RouteLens runs again the requests of those routes that already have a result. Requests nobody ran are not sent on save.
- If the dev server is restarting (connection refused), RouteLens waits up to 5 s for the port, then tries once more.
- The setting `routelens.runOnSave` (default on) turns it off.

**Rescan cache**: parsed files are reused while their size and modified time stay the same. A save then re-parses one file instead of the whole project.

## Why

- **One runner** means the board in VS Code, `routelens run` in CI and the MCP tools (M5) can't disagree about what "passed" means.
- **Checks in the files** are reviewed in pull requests like code, and an AI agent (M5, M7) can write them as plain JSON. The format is our own: small, made for paths into JSON responses, with no scripting. Scripts would be code taken from a repo and run on the person's machine, which we never do.
- **The path syntax is written by hand** (about 40 lines) because no direct dependency covers it. JSONPath libraries are much bigger than what we need.
- **Auto-login on 401** needs no setup and no new file. A person who wants full control writes a flow with a login step and `extract`.

## Consequences

- `requestSchema` gets an optional `expect` field. It is still `version: 1`, so old files stay valid, and drafts keep `expect` like any other field the person owns.
- `ApiResponse` gets `setCookies` (each `Set-Cookie` header on its own), because the `Headers` object merges them into one string.
- `resolveRequest` takes optional typed values for whole-string placeholders.
- The CLI's npm name is `@routelens/cli`, because `routelens` is the extension's package name inside this repo. Once it is a dev dependency, `npx routelens run` works. One-off use: `npx @routelens/cli run`.
