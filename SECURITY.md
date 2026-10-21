# Security policy

RouteLens sends HTTP requests, can start your dev server, keeps logins in your OS keychain, and lets AI agents run requests. Security problems in any of these matter, so please report them privately.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: on this repository, go to **Security → Report a vulnerability**. Describe what you found, how to reproduce it, and what an attacker could do with it.

You can expect a first answer within a week. Once a fix is ready, you'll be credited in the release notes, unless you'd rather not be.

## Supported versions

RouteLens is pre-alpha: only the latest code on `main` is supported.

## What counts

Examples of what we want to hear about:

- Route scanning running project code, or reading files outside the workspace
- RouteLens starting a server without the person's click, or running anything other than the `dev` / `start` script
- A login token sent to a different server than the one that issued it, or secrets written to `.routelens/` files
- The MCP guard rails being bypassed: requests to hosts that aren't allowed, or writes to another machine without the person's OK
- Script injection in the response panel (webview)
