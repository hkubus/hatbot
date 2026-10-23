// Flips Scout marks ready to list: Hatbot asks once for all their marketplaces, then the bot that
// holds the marketplace logins posts each in a desktop task of its own, and Scout hears how it went.
// Scout's tools are called by name through the MCP plugin, without the model.
import { randomUUID } from "node:crypto";
import type { Approval, Bot, ListingStatus, Task } from "@hatbot/shared";
import type { Chats } from "../agent/chats";
import type { Approvals } from "../approvals";
import type { Bots } from "../bots";
import type { Db } from "../db";
import type { Desktop } from "../desktop/service";
import type { EventBus } from "../events";
import { readScout, scoutTool } from "../negotiate/appraise";
import { PluginError, type PluginTool } from "../plugins/plugin";
import { type Plugins, runPluginTool, verdictFor } from "../plugins/registry";
import type { Tasks } from "../tasks/service";
import { type ListingGate, listingAddress } from "./gate";
import {
  addUrl,
  CHANNELS,
  type Channel,
  channelPage,
  conditionWord,
  type Draft,
  listingGoal,
  listingReason,
  listingSummary,
  skillFor,
} from "./text";

export type ListingsDeps = {
  db: Db;
  events: EventBus;
  tasks: Tasks;
  approvals: Approvals;
  bots: Bots;
  plugins: Plugins;
  chats: Chats;
  desktop: Desktop;
  clock?: () => number;
};

type Row = {
  id: number;
  flip_id: number;
  channel: Channel;
  bot_id: string;
  flip_updated_at: string;
  status: ListingStatus;
  draft: string;
  approval_id: number | null;
  task_id: number | null;
  stage: string | null;
  photos: string | null;
  published_at: string | null;
  url: string | null;
  error: string | null;
  reported_at: string | null;
};

/** Not posted yet: a change or a cancel in Scout still stops it. */
const OPEN: ListingStatus[] = ["asking", "queued", "posting"];
/** Ends Scout hears of. A cancel came from Scout. */
const TOLD: ListingStatus[] = ["listed", "failed", "declined"];
const FINAL_TASK = ["done", "failed", "cancelled"];
const MAX_PHOTOS = 20;
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");

function readyFlips(out: Record<string, unknown>) {
  return (Array.isArray(out.flips) ? out.flips : []).flatMap((f) => {
    const o = obj(f);
    if (typeof o.id !== "number" || !str(o.updatedAt)) return [];
    const channels = (Array.isArray(o.channels) ? o.channels : [])
      .map(obj)
      .filter((c) => c.status === "ready" && CHANNELS.includes(c.channel as Channel))
      .map((c) => c.channel as Channel);
    return [{ id: o.id, updatedAt: str(o.updatedAt), channels }];
  });
}

function draftOf(out: Record<string, unknown>): Draft | null {
  const delivery = obj(out.delivery);
  const prices = Object.fromEntries(
    Object.entries(obj(out.prices)).filter(
      ([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0,
    ),
  ) as Record<string, number>;
  const d: Draft = {
    id: Number(out.id),
    updatedAt: str(out.updatedAt),
    title: str(out.title).trim(),
    description: str(out.description).trim(),
    condition: str(out.condition) || null,
    category: str(out.category),
    delivery: {
      shipping: delivery.shipping === true,
      pickup: delivery.pickup === true,
      parcelSize: str(delivery.parcelSize) || null,
    },
    prices,
    currency: (str(out.currency) || "PLN").toUpperCase(),
    photos: (Array.isArray(out.photos) ? out.photos : [])
      .map((p) => obj(p).id)
      .filter((id): id is number => typeof id === "number")
      .slice(0, MAX_PHOTOS),
  };
  return Number.isInteger(d.id) && d.updatedAt && d.title && d.description ? d : null;
}

export class Listings {
  readonly clock: () => number;
  private ticking: Promise<void> | null = null;
  private starting = false;
  /** Rows whose report Scout wouldn't take, already said in the chat. */
  private told = new Set<number>();

  constructor(readonly d: ListingsDeps) {
    this.clock = d.clock ?? Date.now;
    d.events.on((e) => {
      if (e.type === "approval.resolved" && e.approval.kind === "listing")
        void this.decided(e.approval).catch((err) => console.error("listing approval failed", err));
      if (e.type === "task.updated" && FINAL_TASK.includes(e.task.status))
        void this.taskEnded(e.task).catch((err) => console.error("listing task end failed", err));
    });
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private rows(where = "1", ...args: (string | number)[]): Row[] {
    return this.d.db
      .query<Row, (string | number)[]>(`SELECT * FROM flip_listings WHERE ${where} ORDER BY id`)
      .all(...args);
  }

  private set(id: number, cols: Record<string, string | number | null>) {
    const all = { ...cols, updated_at: this.now() };
    this.d.db
      .query(
        `UPDATE flip_listings SET ${Object.keys(all)
          .map((k) => `${k} = ?`)
          .join(", ")} WHERE id = ?`,
      )
      .run(...Object.values(all), id);
  }

  /** The bot that posts: one whose tools include Scout's, Haggler first. */
  private lister(): { bot: Bot; tools: PluginTool[] } | null {
    const bots = this.d.bots.list();
    const haggler = bots.filter((b) => b.name.toLowerCase() === "haggler");
    for (const bot of [...haggler, ...bots.filter((b) => !haggler.includes(b))]) {
      const tools = this.d.plugins.tools(bot.plugins);
      if (scoutTool(tools, "scout_flips_to_list")) return { bot, tools };
    }
    return null;
  }

  /** Every 5 minutes: one at a time. */
  tick(): Promise<void> {
    this.ticking ??= this.check().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async check() {
    if (this.d.tasks.paused()) return;
    const l = this.lister();
    const list = l && scoutTool(l.tools, "scout_flips_to_list");
    if (!l || !list) return;
    const signal = AbortSignal.timeout(60_000);
    for (const r of this.rows("reported_at IS NULL"))
      if (TOLD.includes(r.status)) await this.report(r);
    const readAt = this.now();
    const flips = readyFlips(await readScout(list, {}, signal));
    const want = new Map<string, string>();
    for (const f of flips) for (const c of f.channels) want.set(`${f.id}:${c}`, f.updatedAt);

    for (const r of this.rows()) {
      if (!OPEN.includes(r.status) || r.published_at) continue;
      const at = want.get(`${r.flip_id}:${r.channel}`);
      // Cancelled in Scout, or changed since it was asked about: asked about again.
      if (at === undefined) this.drop(r, "cancelled");
      else if (at !== r.flip_updated_at) this.drop(r, null);
    }
    const rows = new Map(this.rows().map((r) => [`${r.flip_id}:${r.channel}`, r]));
    const ask = new Map<number, Channel[]>();
    for (const f of flips)
      for (const c of f.channels) {
        const r = rows.get(`${f.id}:${c}`);
        // Marked ready again after Scout heard how it ended, or after a cancel.
        const again =
          r &&
          (r.status === "cancelled" ||
            (TOLD.includes(r.status) && r.reported_at !== null && r.reported_at < readAt));
        if (r && !again) continue;
        if (r) this.d.db.query("DELETE FROM flip_listings WHERE id = ?").run(r.id);
        ask.set(f.id, [...(ask.get(f.id) ?? []), c]);
      }
    for (const [flip, channels] of ask) await this.ask(l, flip, channels, signal);
    await this.next();
  }

  /** `status` null: the row goes, to be asked about again. */
  private drop(r: Row, status: ListingStatus | null) {
    // The other channels of the same approval are asked about again with it.
    const asked = r.status === "asking" && r.approval_id !== null;
    const ids = asked
      ? this.rows("approval_id = ? AND status = 'asking'", r.approval_id as number).map((x) => x.id)
      : [r.id];
    for (const id of ids)
      if (status && id === r.id) this.set(id, { status });
      else this.d.db.query("DELETE FROM flip_listings WHERE id = ?").run(id);
    if (asked && this.d.approvals.get(r.approval_id as number)?.status === "pending")
      this.d.approvals.cancel(r.approval_id as number);
    if (r.status === "posting" && r.task_id) this.d.tasks.cancel(r.task_id);
    if (r.stage) void this.d.desktop.agent.dropFiles(r.stage).catch(() => {});
  }

  private async ask(
    l: { bot: Bot; tools: PluginTool[] },
    flipId: number,
    channels: Channel[],
    signal: AbortSignal,
  ) {
    const t = scoutTool(l.tools, "scout_flip");
    if (!t) throw new PluginError("Scout has scout_flips_to_list but no scout_flip.");
    const d = draftOf(await readScout(t, { id: flipId }, signal));
    if (!d) {
      console.error(`Scout's flip #${flipId} has no title or description; not asked about.`);
      return;
    }
    const priced = channels.filter((c) => d.prices[c]);
    if (!priced.length) return;
    const approval = this.d.approvals.create({
      taskId: null,
      botId: l.bot.id,
      conversationId: this.d.chats.direct(l.bot.id).conversationId,
      kind: "listing",
      summary: listingSummary(d, priced),
      reason: listingReason(d, l.bot.name),
    });
    const now = this.now();
    for (const c of priced)
      this.d.db
        .query(
          `INSERT INTO flip_listings (flip_id, channel, bot_id, flip_updated_at, status, draft, approval_id,
             created_at, updated_at) VALUES (?, ?, ?, ?, 'asking', ?, ?, ?, ?)`,
        )
        .run(flipId, c, l.bot.id, d.updatedAt, JSON.stringify(d), approval.id, now, now);
  }

  private async decided(a: Approval) {
    const rows = this.rows("approval_id = ? AND status = 'asking'", a.id);
    if (!rows.length || a.status === "pending") return;
    if (a.status === "approved") {
      for (const r of rows)
        this.set(r.id, {
          status: "queued",
          draft: JSON.stringify({ ...this.draft(r), note: a.note }),
        });
      return this.next();
    }
    if (a.status === "denied") {
      for (const r of rows) {
        this.set(r.id, { status: "declined" });
        await this.report({ ...r, status: "declined" });
      }
      return;
    }
    // Nobody answered: asked again on a later tick, if it's still ready.
    for (const r of rows) this.d.db.query("DELETE FROM flip_listings WHERE id = ?").run(r.id);
  }

  private draft(r: Row): Draft {
    return JSON.parse(r.draft) as Draft;
  }

  /** One posting at a time: the next queued channel, once the last one ended. */
  async next() {
    if (this.starting || this.d.tasks.paused() || this.rows("status = 'posting'").length) return;
    const r = this.rows("status = 'queued'")[0];
    if (!r) return;
    const l = this.lister();
    if (!l) return;
    this.starting = true;
    let started = true;
    try {
      started = await this.post(l, r);
    } catch (err) {
      const why =
        err instanceof PluginError || err instanceof Error ? err.message : "Something went wrong.";
      this.end(r, "failed", `Couldn't start posting it: ${why}`);
      await this.report({ ...r, status: "failed", error: why });
    } finally {
      this.starting = false;
    }
    if (started && this.rows("status = 'queued'").length && !this.rows("status = 'posting'").length)
      await this.next();
  }

  /** False: the desktop is down, and it's tried again on the next tick. */
  private async post(l: { bot: Bot; tools: PluginTool[] }, r: Row): Promise<boolean> {
    const agent = this.d.desktop.agent;
    const status = await agent.status().catch(() => null);
    if (!status) return false;
    if (!status.features?.includes("upload"))
      throw new Error(
        "desktop-agent is older than the brain and can't upload photos. Run Update, then mark it ready in Scout again.",
      );
    const d = this.draft(r);
    const photo = scoutTool(l.tools, "scout_flip_photo");
    if (!photo) throw new Error("Scout has no scout_flip_photo tool.");
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const id of d.photos) {
      const p = await readScout(photo, { id }, AbortSignal.timeout(60_000));
      const ext = PHOTO_TYPES[str(p.mime)];
      if (!ext || !str(p.base64)) throw new Error(`Scout's photo ${id} isn't a JPEG, PNG or WebP.`);
      files.push({
        name: `${files.length + 1}.${ext}`,
        bytes: Buffer.from(str(p.base64), "base64"),
      });
    }
    if (!files.length) throw new Error("The flip has no photos.");
    const stage = `listing-${r.id}-${randomUUID().slice(0, 8)}`;
    await agent.stageFiles(stage, files);
    this.set(r.id, {
      status: "posting",
      stage,
      photos: JSON.stringify(files.map((f) => f.name)),
      error: null,
    });
    const price = d.prices[r.channel] ?? 0;
    this.d.tasks.createDesktopTask({
      title: `List on ${r.channel}: ${d.title}`.slice(0, 80),
      goal: listingGoal(d, r.channel, files.length),
      successCriteria: "The listing is live, and record_listing has its address.",
      origin: "chat",
      botId: r.bot_id,
      skill: skillFor(r.channel),
      // Scout's draft may come from the seller's own listing the flip was bought through.
      taintedBy: `Scout's listing draft for flip #${r.flip_id}`,
      request: `The owner approved posting ${listingSummary(d, [r.channel]).replace(/^List /, "")} (${price} ${d.currency})`,
      // Before it runs: its gate comes from this row.
      created: (id) => this.set(r.id, { task_id: id }),
    });
    return true;
  }

  gateFor(taskId: number): ListingGate | null {
    const r = this.rows("task_id = ? AND status = 'posting'", taskId)[0];
    const page = r && channelPage(r.channel);
    if (!r || !page || !r.stage) return null;
    const d = this.draft(r);
    return {
      channel: r.channel,
      host: page.host,
      addUrl: addUrl(r.channel),
      title: d.title,
      description: d.description,
      price: d.prices[r.channel] ?? 0,
      choices: [d.category, conditionWord(d, r.channel) ?? ""].filter(Boolean),
      photos: d.photos.length,
      stage: r.stage,
      published: r.published_at !== null,
    };
  }

  /** The staged photos' names, by number from 1, all of them by default. */
  photoNames(taskId: number, which?: number[]): string[] | string {
    const r = this.rows("task_id = ? AND status = 'posting'", taskId)[0];
    const names = r?.photos ? (JSON.parse(r.photos) as string[]) : null;
    if (!names) return "This task has no listing.";
    const pick = which?.length ? which : names.map((_, i) => i + 1);
    if (pick.some((i) => !Number.isInteger(i) || i < 1 || i > names.length))
      return `There are ${names.length} photos, numbered from 1.`;
    return pick.map((i) => names[i - 1] as string);
  }

  publishPassed(taskId: number) {
    const r = this.rows("task_id = ? AND status = 'posting'", taskId)[0];
    if (r && !r.published_at) this.set(r.id, { published_at: this.now() });
  }

  recordUrl(taskId: number, url: string): { text: string; ok: boolean } {
    const gate = this.gateFor(taskId);
    const r = this.rows("task_id = ? AND status = 'posting'", taskId)[0];
    if (!gate || !r) return { text: "This task has no listing.", ok: false };
    const wrong = listingAddress(gate, url);
    if (wrong) return { text: wrong, ok: false };
    this.set(r.id, { url: url.split("#")[0] ?? url });
    return { text: "Recorded. Finish the task now.", ok: true };
  }

  private async taskEnded(task: Task) {
    const r = this.rows("task_id = ?", task.id)[0];
    if (!r) return;
    if (r.stage) void this.d.desktop.agent.dropFiles(r.stage).catch(() => {});
    if (r.status !== "posting") return;
    const ended: Row = r.url
      ? { ...r, status: "listed", error: null }
      : {
          ...r,
          status: "failed",
          error: r.published_at
            ? `It may have gone up, but Hatbot didn't get the new listing's address. Check ${r.channel} before marking it ready again.`
            : (task.summary ?? `The task ended: ${task.status}.`).slice(0, 500),
        };
    this.end(r, ended.status, ended.error);
    await this.report(ended);
    await this.next();
  }

  private end(r: Row, status: ListingStatus, error: string | null) {
    this.set(r.id, { status, error, stage: null });
  }

  /** The brain tells Scout, not the model. Tried again each tick until Scout has it. */
  private async report(r: Row) {
    const l = this.lister();
    const t = l && scoutTool(l.tools, "scout_flip_listed");
    if (!t) return;
    const input = {
      flipId: r.flip_id,
      channel: r.channel,
      status: r.status,
      ...(r.url ? { url: r.url } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
    const signal = AbortSignal.timeout(60_000);
    if (verdictFor(t, input, { task: null, signal }, false).action !== "allow") {
      if (!this.told.has(r.id))
        this.d.chats.note(
          r.bot_id,
          `Scout's scout_flip_listed asks before each use, so Scout wasn't told how listing flip #${r.flip_id} on ${r.channel} went. Set it to Allow in Settings → Plugins → MCP.`,
        );
      this.told.add(r.id);
      return;
    }
    const res = await runPluginTool(t, input, { task: null, signal });
    if (!res.isError) this.set(r.id, { reported_at: this.now() });
  }
}
