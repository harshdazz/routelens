# ADR-0003: Requests are versioned JSON files in `.routelens/`

- Status: Accepted
- Date: 2026-10-21

## Context

Saved requests, environments and test flows have to live somewhere. Options: a cloud workspace, a local database, or plain files in the user's repo.

## Decision

Store everything as **plain JSON files inside the user's repo**, in a `.routelens/` folder:

- `requests/*.req.json`
- `environments/*.env.json`
- `flows/*.flow.json` (M3)

Every file has a `"version": 1` field and is validated with a zod schema when read. A JSON Schema is shipped with the extension so the editor gives autocomplete and inline errors.

## Why

- **Git-native:** requests are reviewed in pull requests and stay next to the code they test.
- **No lock-in:** users can read and edit the files without RouteLens.
- **JSON over YAML:** no extra parser dependency, and VS Code has built-in JSON Schema support for autocomplete.
- **Versioned:** a `version` field lets us migrate the format later without breaking old files.

## Consequences

- Secrets must never be stored in these files. Tokens and keys live in VS Code SecretStorage, and environment files hold only non-secret values like `baseUrl`.
- JSON has no comments. If users need notes, we add a `description` field.
- Changing the format means writing a migration from version N to N+1.
