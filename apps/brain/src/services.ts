// Built the same way for the brain (main.ts) and for tests (test/helpers.ts): only the outside world
// is passed in.
import { join } from "node:path";
import { automationPlugin } from "@hatbot/plugin-automation";
import { codePlugin } from "@hatbot/plugin-code";
import { Proxmox } from "@hatbot/plugin-proxmox/client";
import { scoutPlugin } from "@hatbot/plugin-scout";
import type {
  HOST_SERVICES,
  ModelHost,
  Plugin,
  PluginsHost,
  SchedulesService,
} from "@hatbot/plugin-sdk";
import { selfPlugin } from "@hatbot/plugin-self";
import { t3Plugin } from "@hatbot/plugin-t3";
import type { T3Code } from "@hatbot/plugin-t3/client";
import { ACTIVE_TASK_STATUSES } from "@hatbot/shared";
import { Chats } from "./agent/chats";
import { corePlugins } from "./agent/core-tools";
import { type ModelClient, oneShot } from "./agent/model";
import { Models } from "./agent/models";
import { CORE_TOOL_NAMES } from "./agent/tools";
import { createApp } from "./app";
import { Approvals } from "./approvals";
import { Archive } from "./archive";
import { Attachments } from "./attachments";
import { AuthService, FailureLimiter, type PasswordCost } from "./auth/service";
import { Bots } from "./bots";
import { BoxFeeds } from "./box-feeds";
import { Boxes } from "./boxes";
import { Checks, type ChecksDeps } from "./checks";
import type { Config } from "./config";
import type { Db } from "./db";
import type { DesktopAgent } from "./desktop/client";
import { Logins } from "./desktop/logins";
import { Desktop } from "./desktop/service";
import { EventBus } from "./events";
import { Backends } from "./hatbox/backends";
import { type HatboxAgent, HttpHatboxAgent } from "./hatbox/client";
import { ListingPhotos } from "./listing-photos";
import { Listings } from "./listings/service";
import { Proposals } from "./memory/proposals";
import { MemoryStore } from "./memory/store";
import { modelName } from "./models-known";
import { Negotiations } from "./negotiate/service";
import { LinkingNotifier, type Notifier } from "./notify";
import { DeadManPing } from "./ping";
import { Plugins } from "./plugins/registry";
import { Questions } from "./questions";
import { Secrets } from "./secrets";
import { SettingsStore } from "./settings";
import { Spend } from "./spend";
import { Storage, storageLine } from "./storage";
import { Tasks } from "./tasks/service";
import { Teach } from "./teach/service";
import { Skills } from "./teach/skills";
import { TodoReminders } from "./todo-reminders";
import { Updates } from "./updates";

export type Outside = {
  config: Config;
  db: Db;
  clock?: () => number;
  /** Tests' own; the brain's sends each model to the provider plugin that offers it. */
  model?: ModelClient;
  taskModel?: ModelClient;
  agent: DesktopAgent;
  hatbox?: HatboxAgent;
  notifications: Notifier;
  ntfy: ChecksDeps["ntfy"];
  /** Tests' own; the brain's is made from the environment and Settings, afresh each time. */
  proxmox?: Proxmox;
  /** Besides the Code plugin, which is always there. */
  plugins: Plugin[];
  pluginEnv?: Record<string, string | undefined>;
  passwordCost?: PasswordCost;
  pingUrl?: string;
  /** The brain's own reads data/secrets.json. */
  secrets?: Secrets;
  /** For tests. */
  fetch?: ChecksDeps["fetch"];
};

/** Plugins aren't started: the caller starts them. */
export async function createServices(o: Outside) {
  const { config, db, agent } = o;
  const clock = o.clock ?? Date.now;
  const publicUrl = config.publicUrl;
  const auth = new AuthService(db, clock, o.passwordCost);
  const secrets = o.secrets ?? new Secrets(join(config.dataDir, "secrets.json"));
  const events = new EventBus();
  const settings = new SettingsStore(db);
  const spend = new Spend(db, settings, events, clock);
  const memory = new MemoryStore(config.memoryDir, db, events);
  await memory.init();
  const skills = new Skills(db, memory, clock);
  skills.watch(events);
  const archive = new Archive(config.archiveDir, clock);
  const attachments = new Attachments({ db, archive, events }, clock);
  const storage = new Storage({ db, archive, clock });
  const desktop = new Desktop(agent, events, db);
  const files = { desktop: agent, attachments };
  const plugins = new Plugins(
    [
      ...o.plugins,
      codePlugin,
      t3Plugin,
      scoutPlugin,
      selfPlugin,
      automationPlugin,
      ...corePlugins(() => ({
        db,
        clock,
        memory,
        events,
        bots,
        tasks,
        schedules: () => plugins.service<SchedulesService>("schedules"),
        attachments,
        boxes,
        desktop: agent,
        proposals,
        settings,
        t3Ready: (bot) => plugins.readyFor("t3", bot.plugins, bots.leftToOthers(bot)),
      })),
    ],
    {
      db,
      events,
      env: o.pluginEnv,
      secrets,
      files,
      dataDir: config.dataDir,
      reserved: CORE_TOOL_NAMES,
      publicUrl,
      fetch: o.fetch,
      clock,
      services: {
        tasks: () => tasks,
        chats: () => chats,
        bots: () => bots,
        notifier: () => notifier,
        events: () => events,
        settings: () => settings,
        model: (): ModelHost => ({
          ask: (params, ledger, opts) => oneShot({ model: taskModel, spend }, params, ledger, opts),
          name: modelName,
        }),
        spend: () => spend,
        memory: () => memory,
        storage: () => ({ line: async () => storageLine(await storage.measure()) }),
        plugins: (): PluginsHost => ({
          list: () => plugins.list(),
          tools: (only) => plugins.tools(only ?? null),
          signals: async () => [
            ...(agent.configured && !desktop.get().online
              ? [{ key: "desktop", text: "The desktop isn't answering." }]
              : []),
            ...(await plugins.signals()),
          ],
        }),
      } satisfies Record<(typeof HOST_SERVICES)[number], () => unknown>,
    },
  );
  const models = new Models(plugins);
  const model = o.model ?? models;
  const taskModel = o.taskModel ?? o.model ?? models;
  // Haggler, which haggles and lists, gets Scout once it's connected.
  plugins.on("scout:connected", () => {
    const haggler = bots.list().find((b) => b.name.toLowerCase() === "haggler");
    if (haggler?.plugins && !haggler.plugins.includes("scout"))
      bots.update(haggler.id, { plugins: [...haggler.plugins, "scout"] });
  });
  const bots = new Bots(db, events, clock);
  const boxes = new Boxes(db, events, clock, secrets);
  boxes.backends = new Backends(boxes, o.hatbox ?? new HttpHatboxAgent("", ""), settings, clock);
  // Not given the rest at first: attach() hands it what needs the chats in turn.
  const chats = new Chats({
    db,
    memory,
    events,
    spend,
    settings,
    model,
    plugins,
    bots,
    boxes,
    clock,
  });
  const notifier = new LinkingNotifier(
    o.notifications,
    publicUrl,
    () => settings.get().notificationsOpen,
  );
  const approvals = new Approvals(db, events, notifier, publicUrl, clock, bots);
  const questions = new Questions(db, events, notifier, publicUrl, clock, bots);

  // What most services take; each gets its own copy, since some add to theirs later (attach()).
  const core = {
    config,
    db,
    clock,
    publicUrl,
    events,
    settings,
    spend,
    model: taskModel,
    memory,
    skills,
    archive,
    attachments,
    storage,
    desktop,
    plugins,
    bots,
    boxes,
    chats,
    notifier,
    approvals,
    questions,
  };
  const tasks = new Tasks({ ...core });
  events.on((e) => {
    if (e.type === "task.updated" && !ACTIVE_TASK_STATUSES.includes(e.task.status))
      plugins.service<T3Code>("t3")?.forget(`task-${e.task.id}`);
  });
  const teach = new Teach({ ...core, lane: tasks.lane });
  const todoReminders = new TodoReminders({ ...core });
  const proposals = new Proposals({ ...core, tasks });
  const negotiations = new Negotiations({ ...core, tasks });
  tasks.negotiations = negotiations;
  const listings = new Listings({ ...core, tasks });
  tasks.listings = listings;
  tasks.logins = new Logins({ ...core });
  chats.attach({
    tasks,
    approvals,
    attachments,
    desktop: agent,
    negotiations,
    proposals,
  });
  tasks.attach({ proposals });
  const feeds = new BoxFeeds({ db, settings, plugins, bots, clock });
  boxes.connect({ settings, spend, model: taskModel, chats, feeds, notifier, publicUrl });

  const updates = new Updates(config, clock);
  const ping = new DeadManPing({ db, url: o.pingUrl, clock });
  const proxmox = () => o.proxmox ?? new Proxmox(plugins.env());
  const checks = new Checks({
    ...core,
    proxmox,
    updates,
    ntfy: o.ntfy,
    auth,
    ping,
    modelsReady: model === models ? () => plugins.modelProviders().length > 0 : undefined,
    fetch: o.fetch,
  });
  const loginLimits = {
    perIp: new FailureLimiter(10, 15 * 60_000, clock),
    global: new FailureLimiter(50, 15 * 60_000, clock, () => {
      void notifier.send({
        title: "Sign-in is on hold",
        message:
          "50 wrong passwords or codes in 15 minutes. New browsers can't sign in until it calms down; ones you've signed in on before still can.",
        priority: 4,
        tags: ["warning"],
      });
    }),
  };

  const services = {
    ...core,
    models,
    agent,
    auth,
    loginLimits,
    tasks,
    teach,
    todoReminders,
    proposals,
    negotiations,
    listings,
    listingPhotos: new ListingPhotos(o.fetch),
    updates,
    ping,
    proxmox,
    checks,
    secrets,
  };
  return { ...services, app: createApp(services) };
}

export type Services = Awaited<ReturnType<typeof createServices>>;
