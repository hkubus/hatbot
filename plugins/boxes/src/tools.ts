// The box tools: a bot makes and changes boxes, looks at them, and tries their backends.

import {
  askOwner,
  BOT_GONE,
  type CallContext,
  clip,
  ENDS_REPLY,
  PluginError,
  type PluginTool,
  type ToolOutput,
  untrustedBlock,
} from "@hatbot/plugin-sdk";
import {
  type Bot,
  type Box,
  type BoxActionInfo,
  BoxCall,
  HATBOT_ID,
  localDay,
  MAX_BOX_ACTION_NAME,
  MAX_BOX_FEED_NAME,
  MAX_BOX_HTML,
  MAX_WATCH_MINUTES,
  MIN_WATCH_MINUTES,
} from "@hatbot/shared";
import {
  BOX_KEYS,
  type BoxLookAnswer,
  type BoxLookError,
  type BoxLookFetch,
  type BoxStep,
  MAX_LOOK_HEIGHT,
  MAX_LOOK_STEPS,
} from "@hatbot/shared/desktop";
import {
  BOX_CONFIG,
  BOX_PAGE,
  type BoxFile,
  badFiles,
  boxConfig,
  MAX_BOX_FILES,
  MAX_BOX_SOURCE,
} from "@hatbot/shared/hatbox";
import { z } from "zod";
import { ACTION_RUNS_PER_DAY, MAX_BOX_ACTIONS } from "./actions";
import { type Backends, cronProblem, NO_GUEST } from "./backends";
import { BoxError, type Boxes, FRAME_CSP, previewed } from "./boxes";
import type { Deps } from "./deps";
import type { BoxFeed } from "./feeds";
import { pitfalls } from "./pitfalls";

/** What a box tool sees: the plugin's services, and the call's own part. */
export type ToolContext = Partial<CallContext> & {
  boxes: Boxes;
  bots: Deps["bots"];
  tasks: Deps["tasks"];
  settings: Deps["settings"];
  desktop: ReturnType<Deps["desktop"]>;
};

const isCodeBot = (ctx: ToolContext) => Boolean(ctx.bot && ctx.bots.codeBot()?.id === ctx.bot.id);
const gone = (ctx: ToolContext) => Boolean(ctx.bot && !ctx.bots.active(ctx.bot.id));
const untrustedAsks = (ctx: ToolContext) => ctx.settings.get().safety.untrusted ?? true;
const chatTaint = (by: string | null | undefined) => by && `The chat had read: ${by}`;

/**
 * After reading untrusted content, letting a box reach a new host waits for approval: injected text
 * mustn't quietly open a way out.
 */
const asked = async (
  ctx: ToolContext,
  signal: AbortSignal,
  change: { name: string; input: unknown; what: string },
) =>
  ctx.tainted?.() && untrustedAsks(ctx)
    ? askOwner({ approve: ctx.approve, signal }, change, "untrusted")
    : "";

function ownBox(ctx: ToolContext, id: number): Box {
  const box = ctx.boxes.get(id);
  if (!box) throw new BoxError(`There's no box #${id}.`);
  const me = ctx.bot?.id ?? HATBOT_ID;
  if (box.botId !== me && !isCodeBot(ctx))
    throw new BoxError(
      `Box #${id} is ${ctx.bots.nameOf(box.botId) ?? box.botId}'s; leave it to them.`,
    );
  return box;
}

function edited(
  html: string,
  edits: { old: string; new: string }[],
  first = 0,
  where = "the page",
): string {
  return edits.reduce((page, e, i) => {
    const at = page.indexOf(e.old);
    const again = at >= 0 && page.indexOf(e.old, at + 1) >= 0;
    if (at < 0 || again)
      throw new BoxError(
        `Not changed: edit ${first + i + 1}'s old text ${again ? `is in ${where} more than once; give more of it` : `isn't in ${where}`}.`,
      );
    return page.slice(0, at) + e.new + page.slice(at + e.old.length);
  }, html);
}

function boxOutput(ctx: ToolContext, tool: string, text: string, by: string | null): string {
  if (!by) return text;
  ctx.taint?.(by);
  return untrustedBlock("tool_output", text, { tool });
}

/** An error boxes_look's page hit, at its line in the page: Hatbox's script comes `lines` above it. */
function lookError(e: BoxLookError, lines: number | null): string {
  const at = [
    lines !== null && e.line && e.line > lines && `line ${e.line - lines}`,
    e.step && `step ${e.step}`,
    e.count && `${e.count} times`,
  ].filter(Boolean);
  return `- ${e.message}${at.length ? ` (${at.join(", ")})` : ""}`;
}

function stepLabel(s: BoxStep): string {
  if ("click" in s) return `click ${s.click}`;
  if ("type" in s) return `type ${JSON.stringify(clip(s.text, 40))} into ${s.type}`;
  if ("press" in s) return `press ${s.press}`;
  if ("wait" in s) return `wait for ${s.wait}`;
  if ("wait_ms" in s) return `wait ${s.wait_ms} ms`;
  return `eval ${clip(s.eval.replace(/\s+/g, " "), 60)}`;
}

const SELECTOR = z.string().min(1).max(1000).describe("A CSS selector");
const BOX_STEP = z.union([
  z.object({ click: SELECTOR }),
  z.object({ type: SELECTOR, text: z.string().max(10_000).describe("Replaces what's in it") }),
  z.object({ press: z.enum(BOX_KEYS).describe("To the focused element") }),
  z.object({
    wait: SELECTOR.describe("Until this CSS selector matches"),
    ms: z.number().int().min(0).max(5000).optional().describe("2000 if left out"),
  }),
  z.object({ wait_ms: z.number().int().min(0).max(3000) }),
  z.object({
    eval: z
      .string()
      .min(1)
      .max(10_000)
      .describe("JavaScript run in the page, awaited; its value comes back as JSON"),
  }),
]);

function shown(ctx: ToolContext, box: Box): string {
  if (ctx.messageId) ctx.boxes.attach(ctx.messageId, box.id);
  return `Box #${box.id} "${box.title}", version ${box.version}, shows under your reply, where the owner opens it.`;
}

const BOX_TITLE = z.string().min(1).max(80).describe('Short, e.g. "Habit tracker"');

const feedLine = (f: BoxFeed) =>
  `"${f.name}": ${f.tool} ${JSON.stringify(f.input)}, every ${f.everyMinutes} min${f.error ? `; ${f.error}` : ""}\n  ${f.at ? `Latest, ${f.at.slice(0, 16).replace("T", " ")} UTC: ${clip(JSON.stringify(f.value), 2000)}` : "Nothing yet"}`;

const kindOf = (v: unknown) =>
  typeof v === "string" ? "text" : Array.isArray(v) ? "a JSON array" : "a JSON object";
const BOX_FILES = z
  .array(
    z.object({
      path: z.string().min(1).max(100).describe('e.g. "index.html", "server.ts", "lib/chart.ts"'),
      content: z.string().max(MAX_BOX_SOURCE),
    }),
  )
  .min(1)
  .max(MAX_BOX_FILES);

function backends(ctx: ToolContext): Backends {
  const b = ctx.boxes.backends;
  if (!b?.available) throw new BoxError(NO_GUEST);
  return b;
}

const fileKey = (files: BoxFile[] | undefined) =>
  JSON.stringify([...(files ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1)));

/** Whole files first, then removals, then edits. */
function changedFiles(
  current: { html: string; files?: BoxFile[] },
  c: {
    edits?: { file?: string; old: string; new: string }[];
    html?: string;
    files?: BoxFile[];
    remove?: string[];
  },
): BoxFile[] {
  let list = current.files ?? [{ path: BOX_PAGE, content: current.html }];
  const put = (f: BoxFile) => {
    list = [...list.filter((x) => x.path !== f.path), f];
  };
  if (c.html !== undefined) put({ path: BOX_PAGE, content: c.html });
  for (const f of c.files ?? []) put(f);
  list = list.filter((f) => !c.remove?.includes(f.path));
  (c.edits ?? []).forEach((e, i) => {
    const path = e.file ?? BOX_PAGE;
    const f = list.find((x) => x.path === path);
    if (!f) throw new BoxError(`Not changed: edit ${i + 1}'s file, ${path}, isn't in the box.`);
    put({ path, content: edited(f.content, [e], i, path) });
  });
  return list;
}

const configOf = (files: BoxFile[]) => {
  try {
    return boxConfig(files.find((f) => f.path === BOX_CONFIG)?.content);
  } catch {
    return null;
  }
};

/**
 * Every file but the page's .html, .css and .svg counts as backend code: a build for Bun keeps only
 * those out of server.js. Packages and which secrets it reads count too.
 */
function backendChanged(before: BoxFile[], next: BoxFile[]): boolean {
  const code = (files: BoxFile[]) =>
    fileKey(files.filter((f) => f.path !== BOX_CONFIG && !/\.(html|css|svg)$/.test(f.path)));
  const deps = (files: BoxFile[]) => {
    const c = configOf(files);
    return JSON.stringify(c && [c.packages, c.secrets]);
  };
  return code(before) !== code(next) || deps(before) !== deps(next);
}

/**
 * A box with secrets you set asks you every time, past Haiku's review, when its backend may reach a new
 * host, or its code changes in a tainted chat: even a host it already reaches, an API that stores text
 * say, could carry them away. Any secret set counts, declared by this version or not, so dropping one
 * from box.json, adding a host, then declaring it again doesn't get past.
 */
async function secretsAsked(
  ctx: ToolContext,
  signal: AbortSignal,
  c: {
    tool: string;
    input: unknown;
    id?: number;
    title: string;
    before: BoxFile[];
    files: BoxFile[];
    added: string[];
  },
): Promise<string | null> {
  const set = c.id ? (ctx.boxes.setSecretNames(c.id) ?? []) : [];
  const recoded = Boolean(ctx.tainted?.()) && backendChanged(c.before, c.files);
  if (!set.length || (!c.added.length && !recoded)) return null;
  if (!ctx.approve)
    throw new PluginError("Not saved: this needs the owner's approval, which can't be asked here.");
  const hosts = configOf(c.files)?.hosts ?? [];
  const r = await ctx.approve(
    {
      tool: c.tool,
      input: c.input,
      what: `${c.added.length ? `Let box #${c.id} "${c.title}" reach ${c.added.join(", ")}` : `Change the backend code of box #${c.id} "${c.title}"`}. Its backend has the secrets ${set.join(", ")}${hosts.length ? `, and could send them to ${hosts.join(", ")}` : ""}.`,
      why: c.added.length
        ? "This box has secrets you set, so a new host for its backend is checked first."
        : "This conversation has read untrusted content, and changed code could send this box's secrets to a host it already reaches, so it is checked first.",
    },
    signal,
  );
  if (r.isError) throw new PluginError(r.content);
  return r.content;
}

/** Their names and whether each is set, never a value. */
function actionsLine(ctx: ToolContext, id: number): string {
  const list = ctx.boxes.actions?.list(id) ?? [];
  const line = (a: BoxActionInfo) =>
    `"${a.name}": ${a.script} ${JSON.stringify(a.input)}${a.last ? `; last run task #${a.last.task}, ${a.last.status}` : ""}`;
  return list.length ? `Actions:\n${list.map(line).join("\n")}` : "";
}

function secretsLine(ctx: ToolContext, id: number): string {
  const list = ctx.boxes.secrets(id) ?? [];
  return list.length
    ? `Secrets its backend reads from process.env, which the owner sets on the box's page and you never see: ${list.map((x) => `${x.name} (${x.set ? "set" : "not set"})`).join(", ")}.`
    : "";
}

export function unsetSecrets(ctx: ToolContext, id: number): string {
  const unset = (ctx.boxes.secrets(id) ?? []).filter((x) => !x.set).map((x) => x.name);
  return unset.length
    ? ` Its backend reads ${unset.join(", ")}, which the owner hasn't set: they set it on the box's page, under Secrets.`
    : "";
}

/** A failed build's output is untrusted, since npm packages' code and text are in it. */
export async function builtBox(
  ctx: ToolContext,
  signal: AbortSignal,
  b: {
    tool: string;
    id?: number;
    title: string;
    files: BoxFile[];
    hosts: string[];
    before?: BoxFile[];
  },
): Promise<{ id: number; page: string; note: string; warned: string } | string> {
  const guest = backends(ctx);
  const bad = badFiles(b.files);
  if (bad) return `Not saved: ${bad}`;
  const config = boxConfig(b.files.find((f) => f.path === BOX_CONFIG)?.content);
  const late = config.cron && cronProblem(config.cron, Date.now());
  if (late) return `Not saved: ${late}`;
  const added = config.hosts.filter((h) => !b.hosts.includes(h));
  const input = { box: b.id, hosts: added };
  const note =
    (await secretsAsked(ctx, signal, {
      tool: b.tool,
      input,
      id: b.id,
      title: b.title,
      before: b.before ?? [],
      files: b.files,
      added,
    })) ??
    (added.length
      ? await asked(ctx, signal, {
          name: b.tool,
          input,
          what: `Let ${b.id ? `box #${b.id}` : "a new box"} "${b.title}" reach ${added.join(", ")}`,
        })
      : "");
  const id = b.id ?? ctx.boxes.reserve();
  const version = b.id ? ctx.boxes.nextVersion(b.id) : 1;
  const result = await guest.build(id, version, b.files);
  if (!result.ok || result.page === undefined)
    return `Not saved: the build failed. What it printed:\n\n${boxOutput(ctx, b.tool, result.output || "(nothing)", `What building box "${b.title}" printed`)}`;
  return { id, page: result.page, note, warned: result.output.replace(/^Built\.$/m, "").trim() };
}

/**
 * For a box just made or changed: what reading its page found, the build's warnings, and its errors once
 * opened on the desktop as boxes_look does without steps (no picture), so simple breakage shows even if
 * the bot doesn't look. Nothing of the desktop's when there's none or it fails.
 */
async function checked(
  ctx: ToolContext,
  signal: AbortSignal,
  tool: string,
  id: number,
  warned = "",
): Promise<string> {
  const page = ctx.boxes.page(id);
  if (!page) return "";
  const found = pitfalls(
    page.files ?? [{ path: BOX_PAGE, content: page.html }],
    Boolean(page.files),
  );
  const parts = [
    found.length && `Check these before you finish:\n${found.map((x) => `- ${x}`).join("\n")}`,
    warned &&
      `The build warned:\n${boxOutput(ctx, tool, warned, `What building box "${page.title}" printed`)}`,
  ];
  const desktop = ctx.desktop?.configured
    ? (ctx.desktop.withSignal?.(signal) ?? ctx.desktop)
    : null;
  try {
    const { html, lines } = previewed(page.html, false, {});
    const look =
      desktop &&
      (await desktop.lookAtBox({ html, csp: FRAME_CSP, width: 390, height: 844, dark: false }));
    if (look) {
      const errors = look.errors.map((e) => lookError(e, page.files ? null : lines)).join("\n");
      const by = ctx.boxes.taintedBy(id);
      parts.push(
        errors
          ? `Opened it, with errors:\n${boxOutput(ctx, "boxes_look", errors, by ? `Box #${id} "${page.title}", written after reading: ${by}` : null)}`
          : "Opened it: no errors.",
      );
    }
  } catch {
    // Without the desktop it's only not checked.
  }
  const text = parts.filter(Boolean).join("\n\n");
  return text && `\n\n${text}`;
}

/** Shared by the chat's boxes_create and T3 Code (boxes_t3). */
export const BOX_PAGE_RULES =
  "A box is one self-contained HTML page, its CSS and JavaScript inline. It can't load or reach anything outside itself (no CDNs, fonts, pictures from the web or requests), so write plain JavaScript and draw with SVG or canvas. alert, confirm and prompt don't work; show messages and confirmations in the page. localStorage, sessionStorage, indexedDB and cookies are blocked. It keeps its data with hatbox.store: await hatbox.store.get(key), .set(key, value), .delete(key) and .keys(), with JSON values, up to 5 MB in all; load on start, save on each change. Use the app's colours, which follow light and dark: var(--hb-bg), --hb-surface, --hb-text, --hb-muted, --hb-line, --hb-accent (with --hb-on-accent text on it), --hb-attention, --hb-danger, --hb-success, and --hb-font. Make it work on a phone too. It can also await hatbox.ask(prompt, {system, maxTokens}) for Haiku's answer as text (no tools, a small daily limit), hatbox.send(text) for a short note in this chat, which you see the next time the owner writes,, hatbox.feed(name) for what a feed you give it with boxes_feed last read (with {fresh: true}, read again when over a minute old), and hatbox.action(name) to run one of your scripts that you give it as an action with boxes_action.";

export const BOX_FILES_RULES =
  'For more than a page, give files instead, built on the boxes guest into one page: index.html, which loads its scripts and styles by path (<script type="module" src="./app.ts">; inline scripts aren\'t built, so import and TypeScript fail there), the modules they import, npm packages in box.json, and server.ts for a backend (`export default { fetch(req), scheduled?() }` on Bun, keeping data with bun:sqlite in its working folder), which the page calls with await hatbox.fetch(path, init), answered like fetch. The backend reaches only the hosts box.json lists, and cron runs scheduled(), at most every 5 minutes, which may return {notify: "text"} to notify the owner, up to 10 times a day. An API key goes in box.json\'s secrets by name, read as process.env.NAME; the owner sets it on the box\'s page and you never see it: {"hosts": ["shop.example.com"], "cron": "0 * * * *", "packages": {"chart.js": "^4"}, "secrets": ["SHOP_KEY"]}.';

type BoxTool<S extends z.ZodType> = {
  name: string;
  description: string;
  label: string;
  /** Makes or changes a box: left to the code bot when there is one. */
  change?: boolean;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext, signal: AbortSignal) => Promise<ToolOutput>;
};

const def = <S extends z.ZodType>(t: BoxTool<S>) => t;

const TOOLS = [
  def({
    name: "boxes_create",
    label: "Making a box",
    change: true,
    description: `Make a box: a small web app the owner keeps and opens from the chat, such as a tracker, a calculator, a planner or a dashboard. Not for a one-off answer: reply instead, with a chart block if it helps. ${BOX_PAGE_RULES} ${BOX_FILES_RULES} Then try it with boxes_look, with steps that use it as the owner would, check what it saved, and fix what's wrong before you say it's done.`,
    schema: z.object({
      title: BOX_TITLE,
      html: z.string().min(1).max(MAX_BOX_HTML).optional().describe("The whole page"),
      files: BOX_FILES.optional().describe("Or the box's files, index.html among them"),
    }),
    run: async ({ title, html, files }, ctx, signal) => {
      if (gone(ctx)) return BOT_GONE;
      if (!html === !files) return "Not made: give the page as html, or files, not both.";
      if (files) {
        const made = { messageId: ctx.messageId, taintedBy: chatTaint(ctx.tainted?.()) };
        const b = await builtBox(ctx, signal, { tool: "boxes_create", title, files, hosts: [] });
        if (typeof b === "string") return b.replace("Not saved", "Not made");
        const box = ctx.boxes.create(
          {
            botId: ctx.bot?.id ?? HATBOT_ID,
            conversationId: ctx.conversationId ?? null,
            title,
            html: b.page,
            id: b.id,
            files,
          },
          made,
        );
        return `Made it. ${shown(ctx, box)}${unsetSecrets(ctx, box.id)}${b.note}${await checked(ctx, signal, "boxes_create", box.id, b.warned)}`;
      }
      if (!html) return "Not made: give the page as html.";
      const box = ctx.boxes.create(
        {
          botId: ctx.bot?.id ?? HATBOT_ID,
          conversationId: ctx.conversationId ?? null,
          title,
          html,
        },
        { messageId: ctx.messageId, taintedBy: chatTaint(ctx.tainted?.()) },
      );
      return `Made it. ${shown(ctx, box)}${await checked(ctx, signal, "boxes_create", box.id)}`;
    },
  }),
  def({
    name: "boxes_edit",
    label: "Changing a box",
    change: true,
    description:
      "Change one of your boxes, as a new version; the earlier ones are kept. Give edits for a few changes, or the whole new page as html. A box with files takes edits to any of them, whole files to add or replace, and files to remove. Then try it again with boxes_look and its steps.",
    schema: z.object({
      box: z.number().int().describe("The box's number"),
      edits: z
        .array(
          z.object({
            file: z
              .string()
              .optional()
              .describe("For a box with files: which; index.html if left out"),
            old: z.string().min(1).describe("Text in the page, exactly, found there once"),
            new: z.string().describe("What it becomes"),
          }),
        )
        .max(50)
        .optional()
        .describe("Replacements, made in turn"),
      html: z.string().min(1).max(MAX_BOX_HTML).optional().describe("The whole new page"),
      files: BOX_FILES.optional().describe(
        "Whole files to add or replace; a box of one page gets files",
      ),
      remove: z.array(z.string()).max(MAX_BOX_FILES).optional().describe("Files to remove"),
      title: BOX_TITLE.optional(),
    }),
    run: async ({ box: id, edits, html, files, remove, title }, ctx, signal) => {
      const box = ownBox(ctx, id);
      const current = ctx.boxes.page(id);
      if (!current) return `There's no box #${id}.`;
      if (current.files || files || remove?.length) {
        const list = changedFiles(current, { edits, html, files, remove });
        const name = title ?? box.title;
        const same = fileKey(list) === fileKey(current.files);
        if (same && name === box.title) return "No change: the files and title are as they were.";
        const made = { messageId: ctx.messageId, taintedBy: chatTaint(ctx.tainted?.()) };
        const b = same
          ? { page: current.html, note: "", warned: "" }
          : await builtBox(ctx, signal, {
              tool: "boxes_edit",
              id,
              title: name,
              files: list,
              hosts: ctx.boxes.hosts(id),
              before: current.files ?? [],
            });
        if (typeof b === "string") return b;
        const saved = ctx.boxes.save(id, name, b.page, made, list);
        if (!saved) return "No change.";
        const again = same ? "" : await checked(ctx, signal, "boxes_edit", id, b.warned);
        return `Saved. ${shown(ctx, saved)}${unsetSecrets(ctx, id)}${b.note}${again}`;
      }
      const page = edited(html ?? current.html, edits ?? []);
      if (page.length > MAX_BOX_HTML) return "Not changed: the page would be too long.";
      const saved = ctx.boxes.save(id, title ?? box.title, page, {
        messageId: ctx.messageId,
        taintedBy: chatTaint(ctx.tainted?.()),
      });
      if (!saved) return "No change: the page and title are as they were.";
      return `Saved. ${shown(ctx, saved)}${page === current.html ? "" : await checked(ctx, signal, "boxes_edit", id)}`;
    },
  }),
  def({
    name: "boxes_t3",
    label: "Handing the box to T3 Code",
    change: true,
    description: `Have T3 Code make a new box, or change one of yours, as a background task: for a box with more than a little code, or a big change to one. An agent in the owner's T3 Code works on the box's files on its own for a few minutes, and they're saved as the box's next version, shown under your reply. It can't see this conversation, so put everything the box needs in request. You hear when it's done: look at the box with boxes_look then, before you tell the owner. For a small change, use boxes_edit. ${ENDS_REPLY}`,
    schema: z.object({
      request: z
        .string()
        .min(1)
        .max(20_000)
        .describe("What the box should be, or what to change, in full"),
      box: z.number().int().optional().describe("The box to change; leave out for a new one"),
      title: BOX_TITLE.optional().describe("A new box's title, or the box's new one"),
    }),
    run: async ({ request, box: id, title }, ctx) => {
      const { tasks } = ctx;
      if (gone(ctx)) return BOT_GONE;
      const box = id === undefined ? null : ownBox(ctx, id);
      const name = title ?? box?.title;
      if (!name) return "Not started: a new box needs a title.";
      const task = tasks.createBackgroundTask({
        title: (box ? `Change box #${box.id}: ${name}` : `Make a box: ${name}`).slice(0, 80),
        goal: request,
        origin: "chat",
        botId: ctx.bot?.id,
        conversationId: ctx.conversationId,
        message: ctx.messageId,
        // One run on a box at a time: the second would build on files the first is changing.
        runKey: box ? `box:${box.id}` : undefined,
        taintedBy: chatTaint(ctx.tainted?.()),
        request: ctx.ownerSaid?.(),
        askedIn: ctx.answering,
        runner: "box",
        job: { request, ...(box ? { box: box.id } : {}), ...(title ? { title } : {}) },
      });
      if (!task) return `Not started: T3 Code is already working on box #${id}.`;
      return `Started task #${task.id}: T3 Code ${box ? `changes box #${box.id}` : "makes the box"} in the background, and the owner sees its progress under this reply. Don't wait for it. If your reply already says what you started, end it here; otherwise say so in a line.`;
    },
  }),
  def({
    name: "boxes_list",
    label: "Looking at boxes",
    description: "Your boxes, the latest changed first.",
    schema: z.object({}),
    run: async (_, ctx) => {
      const me = ctx.bot?.id ?? HATBOT_ID;
      const list = ctx.boxes.list(isCodeBot(ctx) ? undefined : me) ?? [];
      if (!list.length) return "You haven't made any boxes.";
      return list
        .map(
          (b) =>
            `#${b.id} "${b.title}" (version ${b.version}, changed ${localDay(new Date(b.updatedAt))}${b.botId === me ? "" : `, made by ${ctx.bots.nameOf(b.botId) ?? b.botId}`})`,
        )
        .join("\n");
    },
  }),
  def({
    name: "boxes_read",
    label: "Reading a box",
    description:
      "Read one of your boxes' page (a box with files: its files): the one that opens, or an earlier version.",
    schema: z.object({
      box: z.number().int(),
      version: z.number().int().positive().optional(),
      file: z.string().optional().describe("For a box with files: just this one"),
    }),
    run: async ({ box: id, version, file }, ctx) => {
      const box = ownBox(ctx, id);
      const page = ctx.boxes.page(id, version);
      if (!page) return `Box #${id} has no version ${version}.`;
      const by = ctx.boxes.taintedBy(id);
      const shownFiles = page.files?.filter((f) => !file || f.path === file);
      if (file && !shownFiles?.length) return `Box #${id} has no file ${file}.`;
      const source = shownFiles
        ? shownFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")
        : page.html;
      const text = `Box #${id} "${page.title}", version ${page.n} (${version ? `version ${box.version} opens` : "the one that opens"}):\n\n${source}`;
      const secrets = secretsLine(ctx, id);
      return `${boxOutput(
        ctx,
        "boxes_read",
        text,
        by ? `Box #${id} "${box.title}", written after reading: ${by}` : null,
      )}${secrets && `\n\n${secrets}`}`;
    },
  }),
  def({
    name: "boxes_revert",
    label: "Changing a box",
    change: true,
    description: "Bring back an earlier version of one of your boxes, as a new version.",
    schema: z.object({ box: z.number().int(), version: z.number().int().positive() }),
    run: async ({ box: id, version }, ctx, signal) => {
      const box = ownBox(ctx, id);
      const before = ctx.boxes.hosts(id) ?? [];
      const oldFiles = ctx.boxes.files(id, version) ?? [];
      const added = (configOf(oldFiles)?.hosts ?? []).filter((h) => !before.includes(h));
      const input = { box: id, version, hosts: added };
      const note =
        (await secretsAsked(ctx, signal, {
          tool: "boxes_revert",
          input,
          id,
          title: box.title,
          before: ctx.boxes.files(id) ?? [],
          files: oldFiles,
          added,
        })) ??
        (added.length
          ? await asked(ctx, signal, {
              name: "boxes_revert",
              input,
              what: `Let box #${id} "${box.title}" reach ${added.join(", ")} again`,
            })
          : "");
      const saved = ctx.boxes.revert(id, version, {
        messageId: ctx.messageId,
        taintedBy: chatTaint(ctx.tainted?.()),
      });
      return saved
        ? `Brought back version ${version}. ${shown(ctx, saved)}${note}`
        : `No change: version ${version} is what opens now.`;
    },
  }),
  def({
    name: "boxes_data",
    label: "Reading what a box saved",
    description:
      "What one of your boxes' page has saved with hatbox.store, by key, its feeds with what they last read, its actions, and which of its secrets the owner has set.",
    schema: z.object({ box: z.number().int() }),
    run: async ({ box: id }, ctx) => {
      const box = ownBox(ctx, id);
      const data = ctx.boxes.data(id) ?? {};
      const feeds = ctx.boxes.feeds?.list(id) ?? [];
      const secrets = [actionsLine(ctx, id), secretsLine(ctx, id)].filter(Boolean).join("\n\n");
      if (!Object.keys(data).length && !feeds.length)
        return `Nothing saved yet.${secrets && `\n\n${secrets}`}`;
      // What the page saved is whatever its code and the owner's typing made of it; what its feeds
      // read is whatever their tools found.
      const saved = Object.keys(data).length
        ? clip(JSON.stringify(data, null, 1), 30_000)
        : "Nothing saved yet.";
      return `${boxOutput(
        ctx,
        "boxes_data",
        feeds.length ? `${saved}\n\nFeeds:\n${feeds.map(feedLine).join("\n")}` : saved,
        `What box #${id} "${box.title}" saved`,
      )}${secrets && `\n\n${secrets}`}`;
    },
  }),
  def({
    name: "boxes_look",
    label: "Looking at a box",
    description:
      "See one of your boxes as the owner would: a picture of the top of its page on a phone, or a desktop, with the errors it hit (uncaught exceptions, unhandled rejections, console.error, and what the browser refused it). It's drawn on the desktop with no network. hatbox.store starts empty and keeps what the page saves for that one look; hatbox.ask, .send and .feed fail there, and .fetch unless backend. with_data starts it with what the page saved, and what comes back is then untrusted. Use steps to try what the box does as the owner would (add an item, press its buttons), then check what it saved, which is shown after the steps. backend lets the page's hatbox.fetch reach the box's real backend, live: what it sends really changes the backend's data, and what comes back is untrusted.",
    schema: z.object({
      box: z.number().int(),
      width: z
        .enum(["phone", "desktop"])
        .optional()
        .describe("phone (390 px wide) if left out; desktop is 1280"),
      dark: z.boolean().optional().describe("In the dark theme"),
      with_data: z.boolean().optional().describe("With what the page saved, as the owner sees it"),
      steps: z
        .array(BOX_STEP)
        .max(MAX_LOOK_STEPS)
        .optional()
        .describe(
          "Tried in order once the page has loaded, 25 seconds in all; the first that fails ends the run. The picture is taken after them",
        ),
      backend: z
        .boolean()
        .optional()
        .describe("For a box with a backend: the page's hatbox.fetch reaches it"),
    }),
    run: async ({ box: id, width, dark = false, with_data, steps, backend }, ctx) => {
      const box = ownBox(ctx, id);
      const page = ctx.boxes.page(id);
      if (!page) return `There's no box #${id}.`;
      if (backend && !ctx.boxes.server(id))
        return `Box #${id} has no backend; look without backend.`;
      const guest = backend ? backends(ctx) : null;
      if (!ctx.desktop?.configured)
        return "Not looked at: that needs the desktop, and it isn't set up.";
      const store = with_data ? ctx.boxes.data(id) : {};
      const phone = width !== "desktop";
      const screen = phone ? { width: 390, height: 844 } : { width: 1280, height: 800 };
      const { html, lines } = previewed(page.html, dark, store, Boolean(guest));
      // What the page asked its backend, and how each went, for the model.
      const fetched: string[] = [];
      const answer = async (f: BoxLookFetch): Promise<BoxLookAnswer["answer"]> => {
        const call = BoxCall.safeParse({ ...f, op: "fetch" });
        const what = `${String(f.method ?? "GET").toUpperCase()} ${clip(String(f.path), 200)}`;
        if (!call.success || call.data.op !== "fetch") {
          fetched.push(`- ${what}: refused`);
          return { error: "That isn't a request a box's page can make." };
        }
        try {
          const a = await (guest as Backends).fetch(id, call.data);
          fetched.push(`- ${what}: ${(a.value as { status: number }).status}`);
          return a;
        } catch (err) {
          const why = err instanceof BoxError ? err.message : "Couldn't reach its backend.";
          fetched.push(`- ${what}: ${why}`);
          return { error: why };
        }
      };
      const look = await ctx.desktop.lookAtBox(
        { html, csp: FRAME_CSP, ...screen, dark, ...(steps?.length ? { steps } : {}) },
        guest ? answer : undefined,
      );
      const tall =
        look.height > MAX_LOOK_HEIGHT
          ? ` The page is ${look.height} px tall; the picture shows the top ${MAX_LOOK_HEIGHT}.`
          : "";
      const wide =
        look.width > screen.width
          ? ` It's ${look.width} px wide, wider than the screen, so it scrolls sideways.`
          : "";
      // A built page's lines aren't its files'.
      const errors = look.errors.map((e) => lookError(e, page.files ? null : lines));
      const tried = (steps ?? []).map((s, i) => {
        const r = look.steps?.[i];
        const how = !r
          ? "not run"
          : r.ok
            ? (r.value ?? "done")
            : `failed: ${r.error ?? "it didn't work"}`;
        return `${i + 1}. ${stepLabel(s)}: ${how}`;
      });
      const parts = [
        `Box #${id} "${page.title}", version ${page.n}, on a ${phone ? "phone" : "desktop"} ${screen.width} px wide, ${dark ? "dark" : "light"}, ${with_data ? "with what the page saved" : "with an empty store"}${guest ? ", reaching its backend" : ""}.${tall}${wide}`,
        tried.length && `Steps:\n${tried.join("\n")}`,
        guest &&
          (fetched.length
            ? `Requests to its backend:\n${fetched.join("\n")}`
            : "It made no requests to its backend."),
        errors.length ? `Errors:\n${errors.join("\n")}` : "No errors.",
        (tried.length || guest) &&
          look.store !== undefined &&
          (look.store === "{}" ? "Nothing saved by the end." : `Saved by the end: ${look.store}`),
      ];
      const text = parts.filter(Boolean).join("\n\n");
      // With the owner's data in it, both the errors and the picture show what the page made of it; with
      // its backend, what the backend answered.
      const tainted = ctx.boxes.taintedBy(id);
      const by = with_data
        ? `What box #${id} "${box.title}" showed with what it saved`
        : guest
          ? `What box #${id} "${box.title}" showed with its backend's answers`
          : tainted && `Box #${id} "${box.title}", written after reading: ${tainted}`;
      const out = boxOutput(ctx, "boxes_look", text, by || null);
      return {
        text: by ? `${out}\nThe picture is untrusted too.` : out,
        images: [{ data: look.png, mediaType: "image/png" }],
      };
    },
  }),
  def({
    name: "boxes_feed",
    label: "Giving a box a feed",
    change: true,
    description:
      "Give one of your boxes a feed: one of your plugins' read tools, which the brain runs on a timer without a model, so the box's page shows the latest. The page reads it with await hatbox.feed(name), which gives {value, at, error} (value: the tool's output, parsed when it's JSON; at: when it came; error: why the last run failed, if it did) or undefined before there's one; hatbox.feed(name, {fresh: true}) runs the tool first if its last run is over a minute old. It runs once now; one that fails isn't added. The same name changes it; leave out tool to remove it. At most 10 a box.",
    schema: z.object({
      box: z.number().int(),
      name: z
        .string()
        .min(1)
        .max(MAX_BOX_FEED_NAME)
        .describe('What the page asks hatbox.feed for, e.g. "guests"'),
      tool: z
        .string()
        .optional()
        .describe("Your plugin's read tool, e.g. proxmox_status. Leave out to remove the feed"),
      tool_input: z.record(z.string(), z.unknown()).optional().describe("The tool's input"),
      every_minutes: z
        .number()
        .int()
        .min(MIN_WATCH_MINUTES)
        .max(MAX_WATCH_MINUTES)
        .optional()
        .describe("How often it runs, at least 5 and at most 10080 (a week); 60 if left out"),
    }),
    run: async ({ box: id, name, tool, tool_input, every_minutes }, ctx, signal) => {
      const box = ownBox(ctx, id);
      const feeds = ctx.boxes.feeds;
      if (!feeds) return "Boxes aren't available here.";
      if (!tool)
        return feeds.remove(id, name)
          ? `Removed the feed "${name}".`
          : `Box #${id} has no feed "${name}".`;
      const input = tool_input ?? {};
      const every = every_minutes ?? 60;
      // The page gets what the tool reads. After untrusted content, or for a page written after it,
      // a box that reaches a host is for the owner to allow: the review never sees what the page does with it.
      const chat = ctx.tainted?.() ?? null;
      let note = "";
      if (chat || ctx.boxes.taintedBy(id)) {
        if (!ctx.approve)
          return "Not added: this needs the owner's approval, which can't be asked here.";
        const hosts = ctx.boxes.hosts(id);
        const r = await ctx.approve(
          {
            tool: "boxes_feed",
            input: { box: id, name, tool, tool_input: input, every_minutes: every },
            what: `Give box #${id} "${box.title}" the feed "${name}": ${tool} ${JSON.stringify(input)}, every ${every} min. ${
              hosts.length
                ? `The box can also reach ${hosts.join(", ")}, so it could send what it reads there.`
                : "The box can't reach any host, so what it reads stays in Hatbot."
            }`,
            why: chat
              ? "This conversation has read untrusted content, so giving a box your data is checked first."
              : "This box's page was written after reading untrusted content, so giving it your data is checked first.",
          },
          signal,
        );
        if (r.isError) return r.content;
        note = r.content;
      }
      // It runs with the tools of the bot that added it, which is the code bot on another bot's box.
      const first = await feeds.set(id, ctx.bot?.id ?? HATBOT_ID, {
        name,
        tool,
        input,
        everyMinutes: every,
      });
      // Not what it gave: that's untrusted, and would make adding the next feed ask too.
      return `Added the feed "${name}": it ran and gave ${kindOf(first.value)}. It runs every ${every} min; the page reads it with await hatbox.feed(${JSON.stringify(name)}).${note}`;
    },
  }),
  def({
    name: "boxes_action",
    label: "Giving a box an action",
    change: true,
    description: `Give one of your boxes an action: one of your scripts, with a fixed input, that its page runs with await hatbox.action(name), such as a button that restarts a service or sends a report. Each run is a task, like the script's other runs; the page gets {task, status, summary, at} once it ends, or as it is after 30 seconds, and hatbox.action(name, {check: true}) gives how its last run went without running it. Since the page may run it whenever its code asks, the owner approves an action whose script changes things; each run then follows the script's rules. At most ${MAX_BOX_ACTIONS} a box, run at most ${ACTION_RUNS_PER_DAY} times a day in all. The same name changes it; leave out script to remove it.`,
    schema: z.object({
      box: z.number().int(),
      name: z
        .string()
        .min(1)
        .max(MAX_BOX_ACTION_NAME)
        .describe('What the page asks hatbox.action for, e.g. "restart"'),
      script: z
        .string()
        .optional()
        .describe("Your script's name, from script_list. Leave out to remove the action"),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The script's input, the same on every run"),
    }),
    run: async ({ box: id, name, script, input = {} }, ctx, signal) => {
      const box = ownBox(ctx, id);
      const actions = ctx.boxes.actions;
      if (!actions) return "Boxes aren't available here.";
      if (!script)
        return actions.remove(id, name)
          ? `Removed the action "${name}".`
          : `Box #${id} has no action "${name}".`;
      const s = actions.script(id, ctx.bot?.id ?? HATBOT_ID, { name, script, input });
      // The page runs it whenever its code asks. After untrusted content, or for a page written after
      // it, even a script that only reads gives the page what it read, as a feed does.
      const chat = ctx.tainted?.() ?? null;
      let note = "";
      if (s.writes.length || chat || ctx.boxes.taintedBy(id)) {
        if (!ctx.approve)
          return "Not added: this needs the owner's approval, which can't be asked here.";
        const hosts = ctx.boxes.hosts(id);
        const r = await ctx.approve(
          {
            tool: "boxes_action",
            input: { box: id, name, script: s.name, input },
            what: [
              `Let box #${id} "${box.title}" run the script ${s.name} ${JSON.stringify(input)} whenever its page asks, as the action "${name}", up to ${ACTION_RUNS_PER_DAY} times a day.`,
              s.writes.length && `It changes things with ${s.writes.join(", ")}.`,
              hosts.length &&
                `The box can reach ${hosts.join(", ")}, so it could send what the script gives back there.`,
            ]
              .filter(Boolean)
              .join(" "),
            why: s.writes.length
              ? "A box's page runs its actions whenever its code asks, so one that changes things is yours to allow."
              : chat
                ? "This conversation has read untrusted content, so giving a box your data is checked first."
                : "This box's page was written after reading untrusted content, so giving it your data is checked first.",
            ...(s.writes.length ? { always: true } : {}),
          },
          signal,
        );
        if (r.isError) return r.content;
        note = r.content;
      }
      actions.set(id, name, s, input);
      return `Added the action "${name}": the page runs ${s.name} with await hatbox.action(${JSON.stringify(name)}).${note}`;
    },
  }),
  def({
    name: "boxes_logs",
    label: "Reading a box's logs",
    description:
      "The end of what one of your boxes' backend printed (console.log, errors, scheduled() runs), with notes on fetches it wasn't let make.",
    schema: z.object({ box: z.number().int() }),
    run: async ({ box: id }, ctx) => {
      const box = ownBox(ctx, id);
      const text = await backends(ctx).logs(id);
      if (!text.trim()) return "Its backend hasn't printed anything.";
      // What the backend printed came from its code and whatever the hosts it reaches sent.
      return boxOutput(ctx, "boxes_logs", text, `What box #${id} "${box.title}"'s backend printed`);
    },
  }),
  def({
    name: "boxes_call",
    label: "Trying a box's backend",
    description:
      "Send one of your boxes' backend a request, as its page's hatbox.fetch does, to try it. Or, with scheduled, run its scheduled() once now: what it returns as notify is shown to you, not sent to the owner.",
    schema: z.object({
      box: z.number().int(),
      path: z
        .string()
        .startsWith("/")
        .max(2000)
        .optional()
        .describe('e.g. "/api/prices?days=7"; not with scheduled'),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      body: z.string().max(100_000).optional().describe("JSON or text"),
      scheduled: z.boolean().optional().describe("Run scheduled() instead of a request"),
    }),
    run: async ({ box: id, path, method, body, scheduled }, ctx) => {
      const box = ownBox(ctx, id);
      const by = `What box #${id} "${box.title}"'s backend answered`;
      if (scheduled) {
        const r = await backends(ctx).runNow(id);
        const said = r.ok
          ? r.notify
            ? `scheduled() ran and returned this to notify (not sent): ${r.notify}`
            : "scheduled() ran, with nothing to notify."
          : `scheduled() failed: ${r.error || "no reason given"}`;
        return boxOutput(ctx, "boxes_call", said, by);
      }
      if (!path) throw new PluginError("Give a path, or scheduled.");
      let type = "application/json";
      try {
        JSON.parse(body ?? "");
      } catch {
        type = "text/plain; charset=utf-8";
      }
      const res = await backends(ctx).request(id, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        path,
        headers: body === undefined ? [] : [["content-type", type]],
        body: body === undefined ? undefined : new TextEncoder().encode(body),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const kind = res.headers.get("content-type") ?? "";
      const textual = !kind || /^text\/|json|xml|javascript/.test(kind);
      const answer = textual
        ? clip(new TextDecoder().decode(bytes), 30_000)
        : `(${bytes.byteLength} bytes of ${kind})`;
      return boxOutput(
        ctx,
        "boxes_call",
        `${res.status}${kind ? `, ${kind}` : ""}\n\n${answer}`,
        by,
      );
    },
  }),
];

export function boxTools(d: Deps, boxes: Boxes): PluginTool[] {
  /** Boxes are code: with a code bot, it makes and changes them all. */
  const noCoder = (bot: Bot) => !d.bots.coderFor(bot);
  return TOOLS.map(
    ({ change, run, ...def }): PluginTool => ({
      ...def,
      schema: def.schema as z.ZodType,
      access: "own",
      places: ["chat"],
      deferred: true,
      whole: true,
      ...(change
        ? {
            when: (o) =>
              noCoder(o.bot) && (def.name !== "boxes_t3" || d.plugins.readyFor("t3", o.bot)),
          }
        : {}),
      run: (input, call) => {
        const { bots, tasks, settings } = d;
        const ctx = { ...call, boxes, bots, tasks, settings, desktop: d.desktop() };
        // biome-ignore lint/suspicious/noExplicitAny: each tool's run matches its own schema
        return run(input as any, ctx, call.signal);
      },
    }),
  );
}
