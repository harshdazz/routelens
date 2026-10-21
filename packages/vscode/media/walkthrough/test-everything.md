# Test everything

Click **Test everything** (▶▶) at the top of the Routes view. RouteLens:

- makes a request for any route that has none yet
- starts your dev server if it is off (it asks first)
- runs every request, reads first and deletes last, then every flow
- shows the result on the board: `12 passed · 2 failed`, with ✓ or ✗ next to each route

**Checks.** A request passes when its status is below 400. To expect something else, add an `expect` block to the request file:

```json
"expect": { "status": 400, "body": { "error": "title is required" } }
```

**Flows.** A `.flow.json` file in `.routelens/flows/` runs requests in order and passes values on, like "create a post, then read it back". Plain code replays it, with no AI.

**Login.** When a route answers `401`, RouteLens finds your login route, asks for your login once and reuses the token. Your login is kept in your system keychain, never in files.

**On save.** After a run, saving a route file runs its requests again and updates the ✓/✗ above the handler. Turn it off with the `routelens.runOnSave` setting.

**In CI.** `npx @routelens/cli run` runs the same requests and flows, with a JUnit report for GitHub Actions.
