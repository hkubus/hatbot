// A research task's model and goal (PLAN.md §17), apart from the run so the chat's tools can use them.

/** What research runs on (PLAN.md §17): it plans, weighs sources and writes the report. */
export const RESEARCH_MODEL = "claude-haiku-5-5";
/** Fixed for research, above what a task's effort can be set to (the tasks table takes up to high). */
export const RESEARCH_EFFORT = "xhigh";
const EARLIER_REPORT = "Earlier report to refresh: ";

/** The report a research task's goal names to refresh, or null. */
export function earlierReport(goal: string): string | null {
  const line = goal.split("\n").find((l) => l.startsWith(EARLIER_REPORT));
  return line?.slice(EARLIER_REPORT.length).trim() || null;
}

/** A research task's goal naming the report to refresh, in place of any it named before. */
export function refreshing(goal: string, reportPath: string | null): string {
  const kept = goal
    .split("\n")
    .filter((l) => !l.startsWith(EARLIER_REPORT))
    .join("\n")
    .trim();
  return reportPath ? `${kept}\n\n${EARLIER_REPORT}${reportPath}` : kept;
}
