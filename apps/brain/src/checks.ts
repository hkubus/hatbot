// Settings → Check everything: a quick, real try of each part Hatbot depends on, so a deploy step
// that was missed shows up here instead of in the middle of a task.
import type { Approval, CheckReport, CheckResult, ChecksInfo } from "@hatbot/shared";
import { type ModelClient, modelErrorText } from "./agent/model";
import type { Approvals } from "./approvals";
import type { Archive } from "./archive";
import type { Config } from "./config";
import type { Db } from "./db";
import { migrations } from "./db/migrations";
import { DesktopError } from "./desktop/client";
import type { Desktop } from "./desktop/service";
import type { MemoryStore } from "./memory/store";
import type { Plugins } from "./plugins/registry";
import type { Proxmox } from "./proxmox";
import type { SettingsStore } from "./settings";
import type { Spend } from "./spend";
import type { Updates } from "./updates";

/** The cheapest real model call there is: it proves the key, the network and billing. */
export const CHECK_MODEL = "claude-haiku-5-5";
const CHECK_TIMEOUT_MS = 30_000;
const LOW_DISK_BYTES = 5 * 1024 ** 3;
/** Nightly snapshots: one older than this means they've stopped. */
const SNAPSHOT_MAX_AGE_MS = 36 * 3600_000;
/** Features the brain uses that an older desktop-agent doesn't have. */
const DESKTOP_FEATURES = ["profiles", "exec", "files"];

export type ChecksDeps = {
  db: Db;
  config: Pick<Config, "publicUrl">;
  settings: SettingsStore;
  spend: Spend;
  model: ModelClient;
  memory: MemoryStore;
  archive: Archive;
  desktop: Desktop;
  plugins: Plugins;
  approvals: Approvals;
  proxmox: Proxmox;
  updates: Updates;
  /** Your ntfy server; null when it isn't set up. */
  ntfy: { configured: boolean; health(): Promise<void> } | null;
  /** False when ANTHROPIC_API_KEY is missing. */
  apiKeySet?: boolean;
  /** The brain's time zone; the desktop's should match it. */
  timeZone?: string;
  /** For tests. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  clock?: () => number;
};

type Check = { id: string; name: string; run: () => Promise<Omit<CheckResult, "id" | "name">> };

const ok = (detail: string) => ({ state: "ok" as const, detail });
const warn = (detail: string) => ({ state: "warn" as const, detail });
const fail = (detail: string) => ({ state: "fail" as const, detail });
const skip = (detail: string) => ({ state: "skip" as const, detail });
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Checks {
  private running: Promise<CheckReport> | null = null;
  private clock: () => number;

  constructor(private d: ChecksDeps) {
    this.clock = d.clock ?? Date.now;
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  info(): ChecksInfo {
    const report = this.setting<CheckReport>("checks:last");
    const approvalId = this.setting<number>("checks:approval");
    return { report, approval: approvalId ? this.d.approvals.get(approvalId) : null };
  }

  /** Runs every check at once; a second call while one runs gets the same report. */
  run(): Promise<CheckReport> {
    this.running ??= this.runAll().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * Sends an approval that does nothing either way, so you can try approving from the lock screen:
   * ntfy, its buttons, and the way back in through your reverse proxy.
   */
  tryApproval(): Approval {
    const previous = this.setting<number>("checks:approval");
    if (previous && this.d.approvals.get(previous)?.status === "pending")
      this.d.approvals.cancel(previous);
    const approval = this.d.approvals.create({
      taskId: null,
      kind: "other",
      summary: "Test approval from Check everything",
      reason: "Approve or deny it from the notification. Nothing happens either way.",
    });
    this.save("checks:approval", approval.id);
    return approval;
  }

  private async runAll(): Promise<CheckReport> {
    const startedAt = this.now();
    const checks = this.checks();
    const results = await Promise.all(
      checks.map(async (c): Promise<CheckResult> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`No answer in ${CHECK_TIMEOUT_MS / 1000} seconds.`)),
            CHECK_TIMEOUT_MS,
          );
        });
        try {
          return { id: c.id, name: c.name, ...(await Promise.race([c.run(), timeout])) };
        } catch (err) {
          return { id: c.id, name: c.name, ...fail(errorText(err)) };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const report = { startedAt, finishedAt: this.now(), results };
    this.save("checks:last", report);
    return report;
  }

  private checks(): Check[] {
    const d = this.d;
    const list: Check[] = [
      { id: "database", name: "Database", run: () => this.database() },
      { id: "public-url", name: "Public address", run: () => this.publicUrl() },
      { id: "model", name: "Claude API", run: () => this.modelCall() },
      { id: "memory", name: "Memory", run: () => this.memory() },
      { id: "archive", name: "Archive", run: () => this.archive() },
      { id: "spend", name: "Spending", run: async () => this.spending() },
      { id: "updates", name: "Last update", run: async () => this.lastUpdate() },
      { id: "notifications", name: "Notifications", run: () => this.notifications() },
      { id: "proxmox", name: "Desktop snapshots", run: () => this.snapshots() },
      ...this.desktopChecks(),
      { id: "schedules", name: "Schedules", run: async () => this.schedules() },
      { id: "approvals", name: "Approvals", run: async () => this.approvals() },
    ];
    for (const p of d.plugins.list().filter((p) => p.enabled))
      list.push({
        id: `plugin.${p.id}`,
        name: p.name,
        run: async () => {
          if (p.state !== "ready")
            return p.state === "starting"
              ? warn("Still starting.")
              : fail(p.message ?? "It isn't ready.");
          if (!p.testable) return ok("Ready.");
          return ok(await d.plugins.test(p.id));
        },
      });
    return list;
  }

  private async database() {
    const found = this.d.db.query("PRAGMA quick_check").values().flat().join("; ");
    if (found !== "ok") return fail(`SQLite's quick check found: ${found}`);
    const v =
      this.d.db
        .query<{ v: number | null }, []>("SELECT max(version) AS v FROM schema_migrations")
        .get()?.v ?? 0;
    return ok(`Schema version ${v} of ${migrations.length}.`);
  }

  private async publicUrl() {
    const url = this.d.config.publicUrl;
    if (/^https?:\/\/(localhost|127\.|\[::1\])/.test(url))
      return skip("HATBOT_PUBLIC_URL is a local address.");
    let res: Response;
    try {
      res = await (this.d.fetch ?? fetch)(`${url}/api/v1/health`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return fail(
        `${url} didn't answer from the brain (${errorText(err)}). Notification buttons and webhooks come in that way.`,
      );
    }
    if (!res.ok) return fail(`${url}/api/v1/health answered ${res.status}.`);
    return ok(`${url} reaches the brain.`);
  }

  private async modelCall() {
    if (this.d.settings.get().paused) return skip("Paused.");
    if (this.d.apiKeySet === false) return fail("ANTHROPIC_API_KEY isn't set.");
    try {
      this.d.spend.check(0.001);
      const res = await this.d.model.create({
        model: CHECK_MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the word OK." }],
      });
      this.d.spend.recordResponse({ model: CHECK_MODEL, purpose: "check", usage: res.usage });
      return ok("Haiku 5.5 answered.");
    } catch (err) {
      return fail(`The call failed: ${modelErrorText(err)}`);
    }
  }

  private async memory() {
    const files = await this.d.memory.tree();
    const loose = await this.d.memory.uncommitted();
    if (loose.length)
      return warn(
        `${loose.length} file${loose.length > 1 ? "s were" : " was"} changed outside Hatbot and not committed: ${loose.slice(0, 5).join(", ")}.`,
      );
    return ok(`${files.length} files, all committed.`);
  }

  private async archive() {
    const free = await this.d.archive.probe();
    if (free < LOW_DISK_BYTES) return warn(`Writable, but only ${gib(free)} free.`);
    return ok(`Writable, ${gib(free)} free.`);
  }

  private spending() {
    const s = this.d.spend.summary();
    const line = `$${s.todayUsd.toFixed(2)} of $${s.limits.dailyUsd} today, $${s.monthUsd.toFixed(2)} of $${s.limits.monthlyUsd} this month.`;
    if (s.todayUsd >= s.limits.dailyUsd || s.monthUsd >= s.limits.monthlyUsd)
      return fail(`${line} Nothing runs until a limit resets or you raise it.`);
    if (s.todayUsd >= 0.8 * s.limits.dailyUsd || s.monthUsd >= 0.8 * s.limits.monthlyUsd)
      return warn(line);
    return ok(line);
  }

  private lastUpdate() {
    const info = this.d.updates.info();
    if (!info.source) return skip("Updates aren't set up; deploy.sh sets them up.");
    const s = info.status;
    if (!s) return ok("No update has run yet.");
    if (s.state === "failed") return fail(`The last update failed: ${s.error ?? s.step}.`);
    if (s.state === "done" && s.notes.length)
      return warn(`Still to do by hand after the last update: ${s.notes.join(" ")}`);
    return ok(info.current?.sha ? `Running ${info.current.sha.slice(0, 7)}.` : "Up to date.");
  }

  private async notifications() {
    const ntfy = this.d.ntfy;
    if (!ntfy?.configured)
      return warn("NTFY_URL isn't set, so approvals and results only show in the app.");
    await ntfy.health();
    return ok("Your ntfy server answers. Send a test approval to try the buttons.");
  }

  private async snapshots() {
    const px = this.d.proxmox;
    if (!px.configured) return skip("The Proxmox token or the desktop's id isn't set.");
    const snaps = await px.desktopSnapshots();
    const newest = snaps
      .map((s) => (s.createdAt ? Date.parse(s.createdAt) : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    if (!snaps.length) return warn("The token works, but the desktop has no snapshots.");
    if (this.clock() - newest > SNAPSHOT_MAX_AGE_MS)
      return warn(
        `The newest snapshot is from ${new Date(newest).toLocaleString("en-GB")}; the nightly ones have stopped.`,
      );
    return ok(
      `${snaps.length} snapshots, the newest from ${new Date(newest).toLocaleString("en-GB")}.`,
    );
  }

  private desktopChecks(): Check[] {
    const agent = this.d.desktop.agent;
    if (!agent.configured)
      return [
        { id: "desktop", name: "Desktop", run: async () => skip("DESKTOP_AGENT_URL isn't set.") },
      ];
    const status = agent.status();
    // Every desktop check waits on the one health call.
    const reachable = status.then(
      () => true,
      () => false,
    );
    const ifUp =
      (f: () => Promise<Omit<CheckResult, "id" | "name">>) =>
      async (): Promise<Omit<CheckResult, "id" | "name">> =>
        (await reachable) ? f() : skip("The desktop isn't answering.");
    const brainSha = this.d.updates.info().current?.sha;
    return [
      {
        id: "desktop",
        name: "Desktop",
        run: async () => {
          let s: Awaited<typeof status>;
          try {
            s = await status;
          } catch (err) {
            return fail(`desktop-agent isn't answering: ${errorText(err)}`);
          }
          const missing = DESKTOP_FEATURES.filter((f) => !s.features?.includes(f));
          if (missing.length)
            return warn("desktop-agent is older than the brain. Run Update, or infra/deploy.sh.");
          if (brainSha && s.version && s.version !== brainSha)
            return warn(
              `desktop-agent is ${s.version.slice(0, 7)}, the brain ${brainSha.slice(0, 7)}. Run Update.`,
            );
          if (s.locked) return warn("You have control of it. Hand it back when you're done.");
          return ok(`${s.width}×${s.height}${s.version ? `, ${s.version.slice(0, 7)}` : ""}.`);
        },
      },
      {
        id: "desktop.profiles",
        name: "Browser profiles",
        run: ifUp(async () => {
          const s = await status;
          if (s.profile === undefined) return skip("desktop-agent is too old to say.");
          if (s.profile === null)
            return warn(
              "Every bot shares one browser profile. Run infra/deploy.sh once on the host to install hatbot-chromium.service.",
            );
          return ok(`Chromium runs per bot; now on ${s.profile}'s profile.`);
        }),
      },
      {
        id: "desktop.timezone",
        name: "Desktop time zone",
        run: ifUp(async () => {
          const s = await status;
          const brain = this.d.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (!s.timeZone) return skip("desktop-agent is too old to say.");
          if (s.timeZone !== brain)
            return warn(
              `The desktop is on ${s.timeZone} and the brain on ${brain}. Pages see the desktop's, so set it to yours.`,
            );
          return ok(s.timeZone);
        }),
      },
      {
        id: "desktop.shell",
        name: "Desktop shell",
        run: ifUp(async () => {
          try {
            const r = await agent.exec("echo ok", 10);
            if (r.exitCode !== 0 || !r.output.includes("ok"))
              return fail(`A test command exited with ${r.exitCode}.`);
            return ok("Runs commands.");
          } catch (err) {
            if (err instanceof DesktopError && err.status === 423)
              return skip("You have control of the desktop.");
            if (err instanceof DesktopError && err.status === 503)
              return fail("The shell isn't running. Run infra/deploy.sh once on the host.");
            throw err;
          }
        }),
      },
      {
        id: "desktop.browser",
        name: "Desktop browser",
        run: ifUp(async () => {
          const s = await agent.browserState();
          const tab = s.tabs.find((t) => t.active) ?? s.tabs[0];
          return ok(
            `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"} open${tab?.url ? `, on ${tab.url}` : ""}.`,
          );
        }),
      },
    ];
  }

  private schedules() {
    // Each schedule's last three runs; three failures in a row mean it's broken.
    const rows = this.d.db
      .query<{ name: string; failed: number; runs: number }, []>(
        `SELECT s.name, sum(t.status = 'failed') AS failed, count(*) AS runs FROM schedules s
         JOIN tasks t ON t.id IN (SELECT id FROM tasks WHERE schedule_id = s.id AND parent_id IS NULL ORDER BY id DESC LIMIT 3)
         WHERE s.enabled = 1 GROUP BY s.id`,
      )
      .all();
    const broken = rows.filter((r) => r.runs === 3 && r.failed === 3).map((r) => `"${r.name}"`);
    const count =
      this.d.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM schedules WHERE enabled = 1")
        .get()?.n ?? 0;
    if (broken.length)
      return warn(`Failed its last three runs: ${broken.join(", ")}. Open it in Schedules.`);
    return ok(count ? `${count} on, none failing.` : "None yet.");
  }

  private approvals() {
    const pending = this.d.approvals.list(true);
    const old = pending.filter((a) => this.clock() - Date.parse(a.createdAt) > 12 * 3600_000);
    if (old.length)
      return warn(
        `${old.length} waiting for you for more than 12 hours; they're cancelled after 24.`,
      );
    return ok(pending.length ? `${pending.length} waiting for you.` : "None waiting.");
  }

  private setting<T>(key: string): T | null {
    const row = this.d.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private save(key: string, value: unknown) {
    this.d.db
      .query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
}

/** A report as plain lines, for infra/smoke.sh. */
export function reportText(r: CheckReport): string {
  const word = { ok: "ok  ", warn: "WARN", fail: "FAIL", skip: "skip" };
  return `${r.results.map((c) => `${word[c.state]}  ${c.name}: ${c.detail}`).join("\n")}\n`;
}
