# @routelens/cli

Run your RouteLens requests and flows from the terminal and in CI, with the same runner as the VS Code extension. Plain code, no AI.

> Preview: an early version. Bug reports and ideas are welcome in [GitHub issues](https://github.com/harshdazz/routelens/issues).

```bash
npx @routelens/cli run                      # the project in the current folder
npx @routelens/cli run --start --junit report.xml
```

Once `@routelens/cli` is a dev dependency of your project, `npx routelens run` works too.

## What it runs

- every request in `.routelens/requests/` (reads first, deletes last). A request passes when its status is below 400, or when the response matches its `expect` block.
- every flow in `.routelens/flows/`, step by step. The first failing step stops the flow.

## Options

| Option               | What it does                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `--env <name>`       | Environment from `.routelens/environments` (default `local`)                                 |
| `--var <name=value>` | Set a `{{variable}}`. Repeat for more. `ROUTELENS_VAR_<name>` works too                      |
| `--only <what>`      | Run only `requests` or only `flows`                                                          |
| `--junit <file>`     | Write a JUnit XML report (GitHub Actions, GitLab, Jenkins)                                   |
| `--start`            | Start the dev server (`dev` or `start` script in `package.json`) if it is off; stop it after |
| `--wait <seconds>`   | Wait this long for the server to answer (default 0; 60 with `--start`)                       |
| `--timeout <ms>`     | Timeout of each request (default 30000)                                                      |

**Login:** when a route answers 401, RouteLens logs in with your login request (a `POST` to `/login`, `/auth/login`, `/signin`, `/session`… with a password field) using `ROUTELENS_USERNAME` and `ROUTELENS_PASSWORD`, then reuses the token. Keep them in your CI's secrets, never in files.

**Exit code:** 0 when everything passed, 1 when something failed, 2 when it could not run (no `.routelens/`, server not answering, bad option).

In GitHub Actions, failures also appear as annotations on the request and flow files. See [examples/github-actions/routelens.yml](../../examples/github-actions/routelens.yml) for a complete workflow.
