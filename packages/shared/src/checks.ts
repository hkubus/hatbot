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
  /** The numbers behind the "storage" result. */
  storage?: StorageInfo;
};

/** How much room Hatbot takes: the database and the archive on the HDD. */
export type StorageInfo = {
  at: string;
  databaseBytes: number;
  walBytes: number;
  /** Task and teach screenshots. */
  screensBytes: number;
  /** Chat files. */
  filesBytes: number;
  /** The nightly copies of the database. */
  snapshotsBytes: number;
  /** All of the above, now. */
  totalBytes: number;
  /** How much the total grew over the last 7 days; null until there's a week of samples. */
  growth7dBytes: number | null;
};

export type ChecksInfo = {
  /** The last run, or null before the first. */
  report: CheckReport | null;
  /** The latest test approval, sent to try approving from the phone's lock screen. */
  approval: Approval | null;
};
