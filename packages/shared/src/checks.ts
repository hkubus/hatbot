// Settings → Check everything: a quick, real try of each part Hatbot depends on.
import type { Approval } from "./index";

export type CheckState = "ok" | "warn" | "fail" | "skip";

export type CheckResult = {
  /** Stable, e.g. "desktop.shell" or "plugin.ssh". */
  id: string;
  name: string;
  state: CheckState;
  /** What was found; for warn and fail, what to do about it. */
  detail: string;
};

export type CheckReport = {
  startedAt: string;
  finishedAt: string;
  results: CheckResult[];
};

export type ChecksInfo = {
  /** The last run, or null before the first. */
  report: CheckReport | null;
  /** The latest test approval, sent to try approving from the phone's lock screen. */
  approval: Approval | null;
};
