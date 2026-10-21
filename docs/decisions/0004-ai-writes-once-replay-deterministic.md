# ADR-0004: AI writes a test once, plain code replays it

- Status: Accepted
- Date: 2026-10-21

## Context

RouteLens uses AI to turn English scenarios into API tests ("sign up, log in, create a post, check the feed"). There are two ways to run those tests:

1. Ask the AI model to run the scenario every time.
2. Ask the AI model once to **write** the scenario as plain steps, then replay those steps with normal code.

## Decision

Option 2. The AI agent produces a `.flow.json` file with explicit steps (request, values to extract, assertions). The flow runner replays it with **no AI involved**.

## Why

- **Deterministic:** the same flow gives the same result every run. No flaky tests caused by the model.
- **Free and fast:** replays cost nothing and run in milliseconds, so they can run on every push in CI.
- **Reviewable:** the generated flow is a file the developer reads and edits before committing, just like code.
- **Works offline and in CI** without an API key.

## Consequences

- AI is used only when creating or repairing a flow, and when explaining a failure.
- When an API changes, flows may need regenerating. The drift check (M2) and an "AI repair flow" action (later) handle this.
- We must design a flow format that is expressive enough (extracting values, chaining, assertions) but still simple to read.
