// Teach-by-showing (PLAN.md §1, §5.4): record the owner doing a chore, have Opus draft a skill, save it once reviewed.
import type Anthropic from "@anthropic-ai/sdk";
import { SKILL_NAME, type TeachSession } from "@hatbot/shared";
import { type ModelClient, modelErrorText } from "../agent/model";
import { TEACH_PROMPT } from "../agent/prompt";
import type { Archive } from "../archive";
import type { Db } from "../db";
import type { Desktop } from "../desktop/service";
import type { EventBus } from "../events";
import type { SettingsStore } from "../settings";
import { BudgetError, priceOf, type Spend } from "../spend";
import type { ScreenLane } from "../tasks/lane";
import { describeSteps, Recorder, type RecStep } from "./recorder";
import { type Skills, skillPath } from "./skills";

export const TEACH_MODEL = "claude-opus-5-5";
/** Holds the screen lane while you record, so no task starts on the desktop. */
const TEACH_LANE = -2;
const PAGE_POLL_MS = 1500;
/** Screenshots sent with the recording, spread across it. */
const MAX_SCREENS = 16;
/** Roughly what a 1280x800 screenshot costs in input tokens. */
const SCREEN_TOKENS = 1500;

export class TeachError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(message);
  }
}

export type TeachDeps = {
  db: Db;
  events: EventBus;
  desktop: Desktop;
  lane: ScreenLane;
  archive: Archive;
  model: ModelClient;
  spend: Spend;
  settings: SettingsStore;
  skills: Skills;
  clock?: () => number;
};

type Row = {
  id: number;
  status: TeachSession["status"];
  started_at: string;
  stopped_at: string | null;
  events: string | null;
  name: string | null;
  draft: string | null;
  error: string | null;
};

/** Evenly spread picks from `items`, keeping the first and the last. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from(
    { length: n },
    (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))] as T,
  );
}

/** The skill's name from its front matter or title, else `fallback`. */
function nameOf(skill: string, fallback: string): string {
  const front = /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(skill)?.[1]?.trim();
  if (front && SKILL_NAME.test(front)) return front;
  const title = /^#\s+(.+)$/m.exec(skill)?.[1] ?? "";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return SKILL_NAME.test(slug) ? slug : fallback;
}

export class Teach {
  private rec: { id: number; recorder: Recorder; timer: ReturnType<typeof setInterval> } | null =
    null;
  private clock: () => number;

  constructor(private d: TeachDeps) {
    this.clock = d.clock ?? Date.now;
    // A restart loses a recording in progress (its steps were in memory) and a draft being written.
    d.db.query("UPDATE teach_sessions SET status = 'discarded' WHERE status = 'recording'").run();
    d.db
      .query(
        "UPDATE teach_sessions SET status = 'failed', error = 'Stopped: the brain restarted.' WHERE status = 'drafting'",
      )
      .run();
    // Handing back some other way (the iOS app, say) ends the recording without a skill.
    d.events.on((e) => {
      if (e.type === "desktop.state" && e.state.control === "hatbot" && this.rec)
        void this.discard(this.rec.id).catch((err) => console.error("teach discard failed", err));
    });
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private row(id: number): Row | null {
    return this.d.db.query<Row, [number]>("SELECT * FROM teach_sessions WHERE id = ?").get(id);
  }

  private toSession(r: Row): TeachSession {
    const steps =
      this.rec?.id === r.id
        ? this.rec.recorder.steps.length
        : r.events
          ? (JSON.parse(r.events) as unknown[]).length
          : 0;
    return {
      id: r.id,
      status: r.status,
      startedAt: r.started_at,
      stoppedAt: r.stopped_at,
      steps,
      name: r.name,
      draft: r.draft,
      error: r.error,
    };
  }

  get(id: number): TeachSession | null {
    const r = this.row(id);
    return r ? this.toSession(r) : null;
  }

  /** The recording in progress, and drafts waiting for you. */
  current(): { recording: TeachSession | null; drafts: TeachSession[] } {
    const drafts = this.d.db
      .query<Row, []>(
        "SELECT * FROM teach_sessions WHERE status IN ('drafting', 'draft', 'failed') ORDER BY id DESC LIMIT 20",
      )
      .all()
      .map((r) => this.toSession(r));
    return { recording: this.rec ? this.get(this.rec.id) : null, drafts };
  }

  private update(id: number, patch: Partial<Omit<Row, "id">>, onlyIf?: Row["status"]) {
    const keys = Object.keys(patch);
    const res = this.d.db
      .query(
        `UPDATE teach_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?${onlyIf ? " AND status = ?" : ""}`,
      )
      .run(...(Object.values(patch) as (string | null)[]), id, ...(onlyIf ? [onlyIf] : []));
    if (res.changes) this.emit(id);
  }

  private emit(id: number) {
    const session = this.get(id);
    if (session) this.d.events.emit({ type: "teach.updated", session });
  }

  /** Takes control of the desktop for you and starts recording what you do. */
  async start(): Promise<TeachSession> {
    const { desktop, lane, archive } = this.d;
    if (this.rec) throw new TeachError("Already recording.", 409);
    if (!desktop.agent.configured || !desktop.get().online)
      throw new TeachError("The desktop isn't answering.", 503);
    if (lane.holderId !== null)
      throw new TeachError("A task is using the desktop. Wait for it, or cancel it first.", 409);
    await lane.acquire(TEACH_LANE, new AbortController().signal);
    try {
      await desktop.takeover();
    } catch {
      lane.release(TEACH_LANE);
      throw new TeachError("The desktop isn't answering.", 503);
    }
    const id = this.d.db
      .query<{ id: number }, [string]>(
        "INSERT INTO teach_sessions (status, started_at) VALUES ('recording', ?) RETURNING id",
      )
      .get(this.now())?.id as number;
    const recorder = new Recorder({
      clock: this.clock,
      secretField: async () => {
        const el = await desktop.agent.inspect();
        // Nothing focused in the browser: the typing went somewhere CDP can't see.
        if (!el) throw new Error("no focused element");
        return Boolean(el.secret) || el.type === "password" || el.tag === "iframe";
      },
      snap: async (label) =>
        archive.saveScreen(`teach-${id}`, label, await desktop.agent.screenshot()),
    });
    const poll = async () => {
      try {
        const page = await desktop.agent.context();
        if (this.rec?.id === id) recorder.page(page.url, page.title);
      } catch {
        // Chromium is busy or closed; the next poll tries again.
      }
    };
    this.rec = { id, recorder, timer: setInterval(poll, PAGE_POLL_MS) };
    void poll();
    this.emit(id);
    return this.get(id) as TeachSession;
  }

  /** Your input from the live view, while you have control. */
  input(m: Parameters<Recorder["input"]>[0]) {
    this.rec?.recorder.input(m);
  }

  /** Ends the recording, hands the desktop back, and leaves the steps behind. */
  private async endRecording(id: number): Promise<RecStep[] | null> {
    const rec = this.rec;
    if (rec?.id !== id) return null;
    this.rec = null;
    clearInterval(rec.timer);
    const steps = await rec.recorder.finish();
    await this.d.desktop.handback();
    this.d.lane.release(TEACH_LANE);
    return steps;
  }

  /** Stops the recording and starts writing the skill. */
  async stop(): Promise<TeachSession> {
    const id = this.rec?.id;
    if (id === undefined) throw new TeachError("Nothing is being recorded.", 409);
    const steps = (await this.endRecording(id)) ?? [];
    const acted = steps.some((s) => s.kind !== "page" && s.kind !== "move");
    this.update(id, {
      status: acted ? "drafting" : "failed",
      stopped_at: this.now(),
      events: JSON.stringify(steps),
      error: acted ? null : "Nothing was recorded. Take over and show Hatbot the chore.",
    });
    if (acted) void this.write(id);
    return this.get(id) as TeachSession;
  }

  /** Writes the skill again, after a failure or to start over from the recording. */
  redraft(id: number): TeachSession {
    const r = this.row(id);
    if (!r) throw new TeachError("No such recording.", 404);
    if (r.status !== "failed" && r.status !== "draft")
      throw new TeachError("This recording can't be drafted now.", 409);
    if (!r.events || !(JSON.parse(r.events) as RecStep[]).some((s) => s.kind !== "page"))
      throw new TeachError("Nothing was recorded.", 409);
    this.update(id, { status: "drafting", error: null });
    void this.write(id);
    return this.get(id) as TeachSession;
  }

  /** One Opus call from the step log and a spread of the screenshots. */
  private async write(id: number) {
    const { archive, model, spend } = this.d;
    try {
      const steps = JSON.parse(this.row(id)?.events ?? "[]") as RecStep[];
      const { lines, screens } = describeSteps(steps);
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        { type: "text", text: `<recording>\n${lines.join("\n")}\n</recording>` },
      ];
      // Full size: the log's coordinates are in the screenshots' pixels.
      const picked = spread(
        screens.map((path, i) => ({ path, n: i + 1 })),
        MAX_SCREENS,
      );
      for (const { path, n } of picked) {
        const file = archive.file(path);
        if (!file || !(await file.exists())) continue;
        content.push({ type: "text", text: `Screenshot ${n}:` });
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/webp",
            data: Buffer.from(await file.bytes()).toString("base64"),
          },
        });
      }
      const p = priceOf(TEACH_MODEL);
      const inputTokens = lines.join("\n").length / 3 + picked.length * SCREEN_TOKENS + 3000;
      spend.check((inputTokens * p.input + 8000 * p.output) / 1_000_000);
      const res = await model.create({
        model: TEACH_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system: TEACH_PROMPT,
        messages: [{ role: "user", content }],
      });
      spend.recordResponse({ model: TEACH_MODEL, purpose: "teach", usage: res.usage });
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim()
        .replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1");
      if (res.stop_reason !== "end_turn" || !text)
        throw new Error("The model stopped before the skill was finished.");
      this.update(
        id,
        { status: "draft", draft: text, name: nameOf(text, `skill-${id}`), error: null },
        "drafting",
      );
    } catch (err) {
      const error =
        err instanceof BudgetError
          ? `Not written: ${err.message}`
          : `Failed: ${modelErrorText(err)}`;
      this.update(id, { status: "failed", error }, "drafting");
    }
  }

  /** Saves your reviewed skill to memory as you. This is what makes it trusted. */
  async save(id: number, input: { name: string; content: string; replace?: boolean }) {
    const r = this.row(id);
    if (!r) throw new TeachError("No such recording.", 404);
    if (r.status !== "draft") throw new TeachError("There's no draft to save.", 409);
    const { memory } = this.d.skills;
    if (!input.replace && (await memory.exists(skillPath(input.name))))
      throw new TeachError(`There's already a skill called ${input.name}.`, 409);
    const owner = this.d.settings.get().owner;
    const sha = await this.d.skills.save(input.name, input.content, owner);
    if (sha)
      this.d.events.emit({
        type: "memory.committed",
        sha,
        message: `Add skill ${input.name}`,
        author: owner.name,
      });
    this.update(id, { status: "saved", name: input.name, draft: input.content }, "draft");
    return { session: this.get(id) as TeachSession, path: skillPath(input.name), sha };
  }

  /** Throws the recording or draft away. A recording in progress hands the desktop back. */
  async discard(id: number): Promise<TeachSession> {
    const r = this.row(id);
    if (!r) throw new TeachError("No such recording.", 404);
    if (r.status === "saved") throw new TeachError("This skill is already saved.", 409);
    if (r.status === "recording") await this.endRecording(id);
    this.update(id, { status: "discarded", stopped_at: r.stopped_at ?? this.now() });
    return this.get(id) as TeachSession;
  }

  /** Stops the page poll; for tests and shutdown. */
  close() {
    if (this.rec) clearInterval(this.rec.timer);
  }
}
