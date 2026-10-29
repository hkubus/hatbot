/** Fixed for research, above what a task's effort can be set to (the tasks table takes up to high). */
export const RESEARCH_EFFORT = "xhigh";
const EARLIER_REPORT = "Earlier report to refresh: ";

export function earlierReport(goal: string): string | null {
  const line = goal.split("\n").find((l) => l.startsWith(EARLIER_REPORT));
  return line?.slice(EARLIER_REPORT.length).trim() || null;
}

export function refreshing(goal: string, reportPath: string | null): string {
  const kept = goal
    .split("\n")
    .filter((l) => !l.startsWith(EARLIER_REPORT))
    .join("\n")
    .trim();
  return reportPath ? `${kept}\n\n${EARLIER_REPORT}${reportPath}` : kept;
}
