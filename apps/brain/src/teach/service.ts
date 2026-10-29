// Teach-by-showing: record the owner doing a chore, have Opus draft a skill, save it once reviewed.
import type Anthropic from "@anthropic-ai/sdk";
import type { DesktopService } from "@hatbot/plugin-desktop";
import { SKILL_NAME, type TeachSession } from "@hatbot/shared";
import { type ModelClient, modelErrorText, oneShot } from "../agent/model";
import { TEACH_PROMPT } from "../agent/prompt";
import type { Archive } from "../archive";
import type { Db } from "../db";
import { UserError } from "../errors";
import type { EventBus } from "../events";
import type { SettingsStore } from "../settings";
import { BudgetError, type Spend } from "../spend";
import { describeSteps, OffPage, PAGE_POLL_MS, Recorder, type RecStep } from "./recorder";
import { type Skills, skillPath } from "./skills";

/** Holds the screen lane while you record, so no task starts on the desktop. */
const TEACH_LANE = -2;
const SCREENS_SENT = 16;

export class TeachError extends UserError {}

export type TeachDeps = {
  db: Db;
  events: EventBus;
  /** Null while the Desktop plugin is off. */
  desktop: () => DesktopService | null;
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

/** Steps where you did something, rather than pages loading or the pointer passing by. */
const actions = (steps: RecStep[]) =>
  steps.filter((s) => s.kind !== "page" && s.kind !== "move").length;

function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from(
    { length: n },
    (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))] as T,
  );
}

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
  private rec: {
    id: number;
    recorder: Recorder;
    timer: ReturnType<typeof setInterval>;
    desk: DesktopService;
    /** Stops hearing the live view. */
    off: () => void;
  } | null = null;
  private clock: () => number;

  constructor(private d: TeachDeps) {
    this.clock = d.clock ?? Date.now;
    // A restart loses a recording in progress (its steps were in memory) and a draft being written.
    const lost = d.db
      .query<{ id: number }, []>(
        "UPDATE teach_sessions SET status = 'discarded' WHERE status = 'recording' RETURNING id",
      )
      .all();
    for (const { id } of lost) void this.forgetScreens(id);
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
    const steps = actions(
      this.rec?.id === r.id ? this.rec.recorder.steps : (JSON.parse(r.events ?? "[]") as RecStep[]),
    );
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

  current(): { recording: TeachSession | null; drafts: TeachSession[] } {
    const drafts = this.d.db
      .query<Row, []>(
        "SELECT * FROM teach_sessions WHERE status IN ('drafting', 'draft', 'failed') ORDER BY id DESC LIMIT 20",
      )
      .all()
      .map((r) => this.toSession(r));
    return { recording: this.rec ? this.get(this.rec.id) : null, drafts };
  }

  private update(id: number, patch: Partial<Omit<Row, "id">>, onlyIf?: Row["status"]): boolean {
    const keys = Object.keys(patch);
    const res = this.d.db
      .query(
        `UPDATE teach_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?${onlyIf ? " AND status = ?" : ""}`,
      )
      .run(...(Object.values(patch) as (string | null)[]), id, ...(onlyIf ? [onlyIf] : []));
    if (res.changes) this.emit(id);
    return res.changes > 0;
  }

  private emit(id: number) {
    const session = this.get(id);
    if (session) this.d.events.emit({ type: "teach.updated", session });
  }

  /** `replaces`: the skill this records again, whose name the draft keeps. */
  async start(replaces?: string): Promise<TeachSession> {
    const { archive } = this.d;
    if (this.rec) throw new TeachError("Already recording.", 409);
    const desk = this.d.desktop();
    if (!desk?.agent.configured || !desk.control.get().online)
      throw new TeachError("The desktop isn't answering.", 503);
    const { control: desktop, lane, agent } = desk;
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
      .query<{ id: number }, [string, string | null]>(
        "INSERT INTO teach_sessions (status, started_at, name) VALUES ('recording', ?, ?) RETURNING id",
      )
      .get(this.now(), replaces ?? null)?.id as number;
    const recorder = new Recorder({
      clock: this.clock,
      secretField: async () => {
        const el = await agent.inspect();
        // No page on screen, or the keyboard is elsewhere (the address bar, another window): the typing
        // went somewhere CDP can't see.
        if (!el || el.pageFocus === false) throw new OffPage("the keyboard isn't on a page");
        return {
          secret:
            Boolean(el.secret) ||
            el.type === "password" ||
            el.tag === "iframe" ||
            el.tag === "frame",
          url: el.url ?? null,
        };
      },
      screen: async () => {
        const [bytes, page] = await Promise.all([
          agent.screenshot(),
          // A page that can't say whether it shows a secret may show one. An older desktop-agent that
          // doesn't say at all is taken at its word.
          agent.context(false, true).catch(() => null),
        ]);
        return page && !page.secretShown ? { bytes, url: page.url } : null;
      },
      save: (label, bytes) => archive.saveScreen(`teach-${id}`, label, bytes),
    });
    const poll = async () => {
      try {
        const page = await agent.context();
        if (this.rec?.id === id) recorder.page(page.url, page.title);
      } catch {
        // Chromium is busy or closed; the next poll tries again.
      }
    };
    const offInput = desk.live.onInput((m) => this.input(m));
    const offGone = desk.live.onViewerGone(() => this.viewerGone());
    this.rec = {
      id,
      recorder,
      timer: setInterval(poll, PAGE_POLL_MS),
      desk,
      off: () => {
        offInput();
        offGone();
      },
    };
    void poll();
    this.emit(id);
    return this.get(id) as TeachSession;
  }

  private input(m: Parameters<Recorder["input"]>[0]) {
    this.rec?.recorder.input(m);
  }

  /** A live view that sent input closed: desktop-agent let go of the keys it held, and its key ups are lost. */
  private viewerGone() {
    this.rec?.recorder.keysUp();
  }

  private async endRecording(id: number): Promise<RecStep[] | null> {
    const rec = this.rec;
    if (rec?.id !== id) return null;
    this.rec = null;
    clearInterval(rec.timer);
    rec.off();
    const steps = await rec.recorder.finish();
    await rec.desk.control.handback();
    rec.desk.lane.release(TEACH_LANE);
    return steps;
  }

  async stop(): Promise<TeachSession> {
    const id = this.rec?.id;
    if (id === undefined) throw new TeachError("Nothing is being recorded.", 409);
    const steps = (await this.endRecording(id)) ?? [];
    const acted = actions(steps) > 0;
    // Discarded while the recording was ending: it stays thrown away.
    const ended = this.update(
      id,
      {
        status: acted ? "drafting" : "failed",
        stopped_at: this.now(),
        events: JSON.stringify(steps),
        error: acted ? null : "Nothing was recorded. Take over and show Hatbot the chore.",
      },
      "recording",
    );
    if (acted && ended) void this.write(id);
    return this.get(id) as TeachSession;
  }

  redraft(id: number): TeachSession {
    const r = this.row(id);
    if (!r) throw new TeachError("No such recording.", 404);
    if (r.status !== "failed" && r.status !== "draft")
      throw new TeachError("This recording can't be drafted now.", 409);
    if (!actions(JSON.parse(r.events ?? "[]") as RecStep[]))
      throw new TeachError("Nothing was recorded.", 409);
    this.update(id, { status: "drafting", error: null });
    void this.write(id);
    return this.get(id) as TeachSession;
  }

  private async write(id: number) {
    const { archive } = this.d;
    try {
      const steps = JSON.parse(this.row(id)?.events ?? "[]") as RecStep[];
      const { lines, screens } = describeSteps(steps);
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        { type: "text", text: `<recording>\n${lines.join("\n")}\n</recording>` },
      ];
      // Full size: the log's coordinates are in the screenshots' pixels.
      const picked = spread(
        screens.map((path, i) => ({ path, n: i + 1 })),
        SCREENS_SENT,
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
      const out = await oneShot(
        this.d,
        {
          model: this.d.settings.get().expertModel,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          system: TEACH_PROMPT,
          messages: [{ role: "user", content }],
        },
        { purpose: "teach" },
      );
      const text = out.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1");
      if (!text) throw new Error("The model stopped before the skill was finished.");
      this.update(
        id,
        {
          status: "draft",
          draft: text,
          name: this.row(id)?.name ?? nameOf(text, `skill-${id}`),
          error: null,
        },
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
    this.update(id, { status: "saved", name: input.name, draft: input.content }, "draft");
    await this.forgetScreens(id);
    return { session: this.get(id) as TeachSession, path: skillPath(input.name), sha };
  }

  async discard(id: number): Promise<TeachSession> {
    const r = this.row(id);
    if (!r) throw new TeachError("No such recording.", 404);
    if (r.status === "saved") throw new TeachError("This skill is already saved.", 409);
    if (r.status === "recording") await this.endRecording(id);
    this.update(id, { status: "discarded", stopped_at: r.stopped_at ?? this.now() });
    await this.forgetScreens(id);
    return this.get(id) as TeachSession;
  }

  /**
   * Deletes a recording's screenshots, once its skill is saved or it's thrown away: they may show what
   * you did on a bank's or a shop's pages, and nothing reads them after that.
   */
  private async forgetScreens(id: number) {
    const r = this.row(id);
    if (!r) return;
    const to = r.stopped_at ? Date.parse(r.stopped_at) : this.clock();
    await this.d.archive
      .removeScreens(`teach-${id}`, Date.parse(r.started_at), to)
      .catch((err) => console.error("teach screenshots not removed", err));
  }

  close() {
    if (this.rec) clearInterval(this.rec.timer);
  }
}
