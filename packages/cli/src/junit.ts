import type { FlowRun, RequestRun } from "@routelens/core";

// JUnit XML: the test report format GitHub Actions, GitLab and Jenkins all read.

export interface RequestResult {
  /** Path relative to the project, e.g. `.routelens/requests/create-post.req.json`. */
  file: string;
  run: RequestRun | undefined;
  /** Set when the file could not be read. */
  problem?: string;
}

export interface FlowResult {
  file: string;
  name: string;
  run: FlowRun | undefined;
  problem?: string;
}

/** One `<testsuite>` for the requests, and one per flow with a `<testcase>` per step. */
export function toJUnit(
  requests: readonly RequestResult[],
  flows: readonly FlowResult[],
  durationMs: number,
): string {
  const suites: string[] = [];
  if (requests.length > 0) {
    const cases = requests.map((item) =>
      testCase("requests", item.run?.name ?? item.file, item.file, item.run, item.problem),
    );
    suites.push(suite("requests", cases, sum(requests.map((item) => item.run?.durationMs ?? 0))));
  }
  for (const flow of flows) {
    const steps = flow.run?.steps ?? [];
    const cases = steps.map((step) =>
      testCase(`flow ${flow.name}`, `${step.index + 1}. ${step.name}`, flow.file, step),
    );
    for (const name of flow.run?.skipped ?? []) {
      cases.push({
        xml: `    <testcase classname="${xml(`flow ${flow.name}`)}" name="${xml(name)}" file="${xml(flow.file)}" time="0"><skipped message="an earlier step failed"/></testcase>`,
        failed: false,
        error: false,
      });
    }
    if (flow.problem) {
      cases.push(testCase(`flow ${flow.name}`, flow.name, flow.file, undefined, flow.problem));
    }
    suites.push(suite(`flow ${flow.name}`, cases, flow.run?.durationMs ?? 0));
  }

  const all = suites.join("\n");
  const tests = (all.match(/<testcase /g) ?? []).length;
  const failures = (all.match(/<failure /g) ?? []).length;
  const errors = (all.match(/<error /g) ?? []).length;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="RouteLens" tests="${tests}" failures="${failures}" errors="${errors}" time="${seconds(durationMs)}">`,
    all,
    "</testsuites>",
    "",
  ].join("\n");
}

interface Case {
  xml: string;
  failed: boolean;
  error: boolean;
}

function testCase(
  classname: string,
  name: string,
  file: string,
  run: RequestRun | undefined,
  problem?: string,
): Case {
  const open = `    <testcase classname="${xml(classname)}" name="${xml(name)}" file="${xml(file)}" time="${seconds(run?.durationMs ?? 0)}">`;
  if (problem || !run) {
    const message = problem ?? "not run";
    return {
      xml: `${open}<error message="${xml(message)}" type="invalid-file"/></testcase>`,
      failed: false,
      error: true,
    };
  }
  if (run.error) {
    return {
      xml: `${open}<error message="${xml(run.error.message)}" type="${xml(run.error.code)}"/></testcase>`,
      failed: false,
      error: true,
    };
  }
  if (!run.passed) {
    const failed = run.checks.filter((check) => !check.passed);
    const message = failed
      .map((check) => (check.detail ? `${check.label}: ${check.detail}` : check.label))
      .join("; ");
    const details = [
      `${run.method} ${run.url}`,
      ...run.checks.map(
        (check) =>
          `${check.passed ? "✓" : "✗"} ${check.label}${check.detail ? `: ${check.detail}` : ""}`,
      ),
    ].join("\n");
    return {
      xml: `${open}<failure message="${xml(message)}" type="check">${xml(details)}</failure></testcase>`,
      failed: true,
      error: false,
    };
  }
  return { xml: `${open}</testcase>`, failed: false, error: false };
}

function suite(name: string, cases: readonly Case[], durationMs: number): string {
  const failures = cases.filter((item) => item.failed).length;
  const errors = cases.filter((item) => item.error).length;
  return [
    `  <testsuite name="${xml(name)}" tests="${cases.length}" failures="${failures}" errors="${errors}" time="${seconds(durationMs)}">`,
    ...cases.map((item) => item.xml),
    "  </testsuite>",
  ].join("\n");
}

/** Escape text for XML attributes and content, and drop characters XML cannot hold. */
export function xml(text: string): string {
  return text
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
