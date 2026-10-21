// When may RouteLens start the user's dev server? Pure logic, unit-tested (see ADR-0006).
//
// Starting a server runs the project's own code, so:
// - only in trusted workspaces (checked by the caller),
// - only the `dev` / `start` script from package.json (core `detectServer`),
// - the first start in each workspace always needs a click,
// - after that, the `routelens.autoStartServer` setting decides.

export const AUTO_START_VALUES = ["ask", "always", "never"] as const;
export type AutoStartSetting = (typeof AUTO_START_VALUES)[number];

export type StartDecision =
  /** Start without asking. */
  | "start"
  /** Show "▶ Start server". */
  | "ask"
  /** Do not offer to start. */
  | "skip";

/**
 * @param setting value of `routelens.autoStartServer` (unknown values count as "ask")
 * @param approvedBefore the user clicked "Start server" in this workspace before
 */
export function startDecision(setting: string | undefined, approvedBefore: boolean): StartDecision {
  if (setting === "never") return "skip";
  if (setting === "always" && approvedBefore) return "start";
  return "ask";
}
