# ADR-0005: Use the AI the user already has, with MCP first and local AI as Private mode

- Status: Accepted
- Date: 2026-10-21
- Changes: the AI part of the product spec and roadmap ("bring your own key" as the main path)

## Context

RouteLens should feel automatic, with as little manual work as possible. Some steps need an AI model, for example writing a test flow from English or explaining a failure. We compared four ways to get one:

|                           | A. User's AI agent via MCP (Claude Code, Cursor, Copilot agent mode) | B. VS Code built-in AI (`vscode.lm`, Copilot models) | C. Local model (Ollama)                                                                          | D. User's own API key     |
| ------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------- |
| Setup                     | none, RouteLens registers itself                                     | one "Allow" click                                    | install Ollama + download a ~5 GB model                                                          | create a key and paste it |
| Cost to the user          | their existing plan                                                  | Copilot has a free plan                              | free                                                                                             | pay per use               |
| Privacy                   | code goes to their AI provider                                       | code goes to GitHub's cloud                          | never leaves the machine                                                                         | code goes to the provider |
| Quality                   | best                                                                 | very good                                            | fine for simple tasks, weak at multi-step tool use                                               | best                      |
| Speed on a typical laptop | fast                                                                 | fast                                                 | slow without a GPU (tested target: i5-1135G7, 16 GB RAM, no NVIDIA card: a few words per second) | fast                      |
| Works offline             | no                                                                   | no                                                   | yes                                                                                              | no                        |
| Works outside VS Code     | yes                                                                  | no                                                   | yes                                                                                              | yes                       |

Picking only one fails someone: local-only adds the most friction and is slow on normal laptops, cloud-only fails people who can't send code outside their machine, and Copilot-only fails Cursor and Claude Code users.

## Decision

1. **Plain code does everything it can.** Finding the server, scanning routes, building requests, running them, re-running on save, and replaying flows need no AI. AI is only for steps that need judgement ([ADR-0004](0004-ai-writes-once-replay-deterministic.md) still holds: AI writes a flow once, plain code replays it).
2. **MCP first.** `packages/mcp` exposes RouteLens as tools (`list_routes`, `send_request`, `run_all`, `run_flow`, `get_last_failure`, ...). The extension registers the server with VS Code automatically, and there is a one-click setup for Claude Code and Cursor. The user's own agent is the brain.
3. **Inside RouteLens, pick the brain automatically**, in this order:
   1. VS Code's built-in language model (Copilot), after the user allows it once
   2. Ollama, if it is running on `localhost:11434`
   3. an API key (Anthropic or OpenAI) stored in SecretStorage
   4. none: every non-AI feature still works, and an "Add AI" button explains the options
4. **Private mode** is a setting that allows local models only. When it is on, RouteLens sends nothing outside the machine except the user's own API requests.
5. **RouteLens never runs its own AI servers or bills for AI.**

## Why

- **Frictionless:** most users already have an AI agent or Copilot, so the common path needs zero setup and zero keys.
- **Best quality where it matters:** multi-step work (explore routes, run, read code, fix) happens in strong models the user already pays for.
- **Privacy is still a real option:** Private mode serves companies and users who can't send code to the cloud.
- **Cheap to run:** we have no model bills and no servers, which suits an open-source, local-first project.
- **Portfolio:** an MCP server plus the VS Code Language Model API shows current, in-demand skills.

## Consequences

- `packages/core` defines a small `ModelProvider` interface and never imports `vscode`. The extension adds an adapter for `vscode.lm`; core adapters cover Ollama (through its OpenAI-compatible endpoint) and API keys.
- Registering the MCP server from the extension needs a newer VS Code API (MCP server definition provider, 1.101 or newer). We raise `engines.vscode` when building the MCP milestone and check the exact version then.
- MCP tools can send real requests, so they need guard rails: by default they only call hosts from the project's environment files, and non-local `POST`/`PUT`/`PATCH`/`DELETE` calls need the user's confirmation.
- Quality differs between brains. The eval set runs against at least Copilot and one Ollama model, and the UI says which brain answered.
- Built-in AI ships after the first public release (v0.2). v0.1 ships with MCP, so AI agents can use RouteLens from day one.
