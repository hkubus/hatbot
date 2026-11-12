// Teach-by-showing: record the owner doing a chore, have Opus draft a skill, save it once reviewed.

import type { ComputersService } from "@hatbot/plugin-computer";
import {
  BudgetError,
  type Db,
  type EventsHost,
  type ModelHost,
  type ModelMessageParam,
  modelErrorText,
  PluginError,
  type PluginScreens,
  type SettingsHost,
  type SkillsHost,
} from "@hatbot/plugin-sdk";
import { SKILL_NAME, type TeachSession } from "@hatbot/shared";
import type { DesktopService } from "../index";
import { TEACH_PROMPT } from "./prompt";
import { describeSteps, PAGE_POLL_MS, Recorder, type RecStep } from "./recorder";
import { computerScreen, desktopScreen, TEACH_LANE, type TeachScreen } from "./screens";

const SCREENS_SENT = 16;

export class TeachError extends PluginError {}

export type TeachDeps = {
  db: Db;
  events: EventsHost;
  desktop: Omit<DesktopService, "teach">;
  /** Your computers, when their plugin is on. */
  computers?: () => ComputersService | null;
  screens: PluginScreens;
  model: ModelHost;
  settings: SettingsHost;
  skills: SkillsHost;
  clock?: () => number;
};

const skillPath = (name: string) => `skills/${name}.md`;

type Row = {
  id: number;
  status: TeachSession["status"];
  started_at: string;
  stopped_at: string | null;
  events: string | null;
  name: string | null;
  draft: string | null;
  error: string | null;
  screen: string | null;
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
    screen: TeachScreen;
    /** Stops hearing the live view. */
    off: () => void;
  } | null = null;
  private clock: () => number;
  private unlisten: () => void;

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
    // Handing back some other way (the iOS app, say), or the computer taking itself back, ends the
    // recording without a skill.
    this.unlisten = d.events.on((e) => {
      const rec = this.rec;
      if ((e.type === "desktop.state" || e.type === "computers") && rec?.screen.lost())
        void this.discard(rec.id).catch((err) => console.error("teach discard failed", err));
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
      screen: r.screen,
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

  /** The desktop, or a computer by its id. */
  private screen(id: string | null): TeachScreen {
    if (id === null) return desktopScreen(this.d.desktop);
    const c = this.d.computers?.()?.screen(id);
    if (!c) throw new TeachError("That computer is gone.", 404);
    return computerScreen(c);
  }

  /**
   * `replaces`: the skill this records again, whose name the draft keeps, on the screen it was shown on
   * unless `screenId` says. `screenId`: a computer's id; null for the desktop.
   */
  async start(replaces?: string, screenId?: string | null): Promise<TeachSession> {
    const { screens } = this.d;
    if (this.rec) throw new TeachError("Already recording.", 409);
    const screen = this.screen(
      screenId === undefined && replaces ? this.shownOn(replaces) : (screenId ?? null),
    );
    const why = screen.unavailable();
    if (why) throw new TeachError(why, 503);
    const { lane } = screen;
    if (lane.holderId !== null)
      throw new TeachError(`A task is using ${screen.name}. Wait for it, or cancel it first.`, 409);
    await lane.acquire(TEACH_LANE, new AbortController().signal);
    try {
      await screen.takeover();
    } catch {
      lane.release(TEACH_LANE);
      throw new TeachError(
        screen.id === null ? "The desktop isn't answering." : `${screen.name} isn't answering.`,
        503,
      );
    }
    const id = this.d.db
      .query<{ id: number }, [string, string | null, string | null]>(
        "INSERT INTO teach_sessions (status, started_at, name, screen) VALUES ('recording', ?, ?, ?) RETURNING id",
      )
      .get(this.now(), replaces ?? null, screen.id)?.id as number;
    const recorder = new Recorder({
      clock: this.clock,
      secretField: () => screen.field(),
      screen: () => screen.shot(),
      save: (label, bytes) => screens.save(`teach-${id}`, label, bytes),
    });
    // A computer's tree can take longer to read than a poll's interval.
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const page = await screen.page();
        if (this.rec?.id === id) recorder.page(page.url, page.title, page.app);
      } catch {
        // The browser or the computer is busy or gone; the next poll tries again.
      } finally {
        polling = false;
      }
    };
    const offInput = screen.live.onInput((m) => this.input(m));
    const offGone = screen.live.onViewerGone(() => this.viewerGone());
    this.rec = {
      id,
      recorder,
      timer: setInterval(poll, PAGE_POLL_MS),
      screen,
      off: () => {
        offInput();
        offGone();
      },
    };
    void poll();
    this.emit(id);
    return this.get(id) as TeachSession;
  }

  /** The screen a skill was last shown on: a computer's id, or null for the desktop. */
  private shownOn(skill: string): string | null {
    return (
      this.d.db
        .query<{ screen: string | null }, [string]>(
          "SELECT screen FROM teach_sessions WHERE name = ? AND status = 'saved' ORDER BY id DESC LIMIT 1",
        )
        .get(skill)?.screen ?? null
    );
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
    await rec.screen.handback();
    rec.screen.lane.release(TEACH_LANE);
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
    const { screens } = this.d;
    try {
      const row = this.row(id);
      const steps = JSON.parse(row?.events ?? "[]") as RecStep[];
      const { lines, screens: shots } = describeSteps(steps);
      const content: Extract<ModelMessageParam["content"], unknown[]> = [
        {
          type: "text",
          text: `<screen>${this.about(row?.screen ?? null)}</screen>\n\n<recording>\n${lines.join("\n")}\n</recording>`,
        },
      ];
      // Full size: the log's coordinates are in the screenshots' pixels.
      const picked = spread(
        shots.map((path, i) => ({ path, n: i + 1 })),
        SCREENS_SENT,
      );
      for (const { path, n } of picked) {
        const bytes = await screens.read(path);
        if (!bytes) continue;
        content.push({ type: "text", text: `Screenshot ${n}:` });
        content.push({
          type: "image",
          source: {
            type: "base64",
            // The desktop's are WebP, a computer's JPEG.
            media_type: bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/webp",
            data: Buffer.from(bytes).toString("base64"),
          },
        });
      }
      const out = await this.d.model.ask(
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

  /** Which screen a recording was made on, for its draft. */
  private about(screen: string | null): string {
    if (screen === null) return "Hatbot's own desktop: Linux (XFCE) with Chromium, 1280x800.";
    const c = this.d.computers?.()?.screen(screen);
    if (!c) return "One of the owner's own computers, since removed.";
    const system = c.system();
    const on = system === "windows" ? "Windows" : system ? `Linux (${system})` : null;
    return `The owner's own computer "${c.name}"${on ? `, on ${on}` : ""}.`;
  }

  /** Saves your reviewed skill to memory as you. This is what makes it trusted. */
  async save(id: number, input: { name: string; content: string; replace?: boolean }) {
    const r = this.row(id);
    if (!r) throw new TeachError("No such recording.", 404);
    if (r.status !== "draft") throw new TeachError("There's no draft to save.", 409);
    if (!input.replace && (await this.d.skills.exists(input.name)))
      throw new TeachError(`There's already a skill called ${input.name}.`, 409);
    const sha = await this.d.skills.save(input.name, input.content);
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
    await this.d.screens
      .remove(`teach-${id}`, Date.parse(r.started_at), to)
      .catch((err) => console.error("teach screenshots not removed", err));
  }

  close() {
    this.unlisten();
    if (this.rec) clearInterval(this.rec.timer);
  }
}
