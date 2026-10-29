// Built the same way for the brain (main.ts) and for tests (test/helpers.ts): only the outside world
// is passed in.
import { join } from "node:path";
import { automationPlugin } from "@hatbot/plugin-automation";
import { boxesPlugin, type HatboxAgent } from "@hatbot/plugin-boxes";
import { codePlugin } from "@hatbot/plugin-code";
import { type DesktopAgent, type DesktopService, desktopPlugin } from "@hatbot/plugin-desktop";
import { Proxmox } from "@hatbot/plugin-proxmox/client";
import { researchPlugin } from "@hatbot/plugin-research";
import { scoutPlugin } from "@hatbot/plugin-scout";
import {
  HOST_SERVICES,
  type Hosts,
  type Notifier,
  type Plugin,
  type SchedulesService,
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
import { Checks, type ChecksDeps } from "./checks";
import type { Config } from "./config";
import type { Db } from "./db";
import { EventBus } from "./events";
import { ListingPhotos } from "./listing-photos";
import { Listings } from "./listings/service";
import { Proposals } from "./memory/proposals";
import { Skills, skillPath } from "./memory/skills";
import { MemoryConflict, MemoryStore } from "./memory/store";
import { modelName } from "./models-known";
import { Logins } from "./negotiate/logins";
import { Negotiations } from "./negotiate/service";
import { LinkingNotifier } from "./notify";
import { DeadManPing } from "./ping";
import { Installer } from "./plugins/installer";
import { Plugins } from "./plugins/registry";
import { Questions } from "./questions";
import { Secrets } from "./secrets";
import { SettingsStore } from "./settings";
import { requestCeiling, Spend } from "./spend";
import { Storage, storageLine } from "./storage";
import { Tasks } from "./tasks/service";
import { TodoReminders } from "./todo-reminders";
import { Updates } from "./updates";

export type Outside = {
  config: Config;
  db: Db;
  clock?: () => number;
  /** Tests' own; the brain's sends each model to the provider plugin that offers it. */
  model?: ModelClient;
  taskModel?: ModelClient;
  /** Tests' stand-in for desktop-agent. */
  agent?: DesktopAgent;
  /** Tests' stand-in for the boxes guest. */
  hatbox?: HatboxAgent;
  notifications: Notifier;
  ntfy: ChecksDeps["ntfy"];
  /** Tests' own; the brain's is made from the environment and Settings, afresh each time. */
  proxmox?: Proxmox;
  /** Those that need nothing of the brain's to be made; the rest are made here. */
  plugins: Plugin[];
  pluginEnv?: Record<string, string | undefined>;
  passwordCost?: PasswordCost;
  pingUrl?: string;
  /** The brain's own reads data/secrets.json. */
  secrets?: Secrets;
  /** For tests. */
  fetch?: ChecksDeps["fetch"];
  /** Starts the brain again, to load plugins installed or removed; tests' records it. */
  restart?: () => void;
  /** Tests install from repositories on this machine. */
  localInstalls?: boolean;
};

/** Plugins aren't started: the caller starts them. */
export async function createServices(o: Outside) {
  const { config, db } = o;
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
  const files = {
    attachments,
    screens: {
      save: (owner: string, name: string, bytes: Uint8Array) =>
        archive.saveScreen(owner, name, bytes),
      read: async (path: string) => {
        const f = archive.file(path);
        return f && (await f.exists()) ? await f.bytes() : null;
      },
      remove: (owner: string, from: number, to: number) => archive.removeScreens(owner, from, to),
    },
  };
  const desktop = () => plugins.service<DesktopService>("desktop");
  const builtIn: Plugin[] = [
    ...o.plugins,
    desktopPlugin(o.agent),
    codePlugin,
    t3Plugin,
    scoutPlugin,
    selfPlugin,
    automationPlugin,
    researchPlugin,
    boxesPlugin(o.hatbox),
    ...corePlugins(() => ({
      db,
      clock,
      memory,
      events,
      bots,
      tasks,
      schedules: () => plugins.service<SchedulesService>("schedules"),
      attachments,
      desktop: desktop()?.agent,
      settings,
    })),
  ];
  const installer = new Installer({
    db,
    dir: join(config.dataDir, "installed"),
    builtIn: () => builtIn,
    coreServices: [...HOST_SERVICES],
    clock,
    local: o.localInstalls,
  });
  const plugins = new Plugins([...builtIn, ...(await installer.load())], {
    db,
    events,
    env: o.pluginEnv,
    secrets,
    files,
    dataDir: config.dataDir,
    reserved: CORE_TOOL_NAMES,
    sourceOf: (id) => {
      const p = installer.get(id);
      return p && { url: p.url, commit: p.commit };
    },
    publicUrl,
    fetch: o.fetch,
    clock,
    release: () => updates.info().current?.sha ?? null,
    services: {
      tasks: () => tasks,
      chats: () => chats,
      bots: () => bots,
      notifier: () => notifier,
      events: () => events,
      settings: () => settings,
      model: () => ({
        ask: (params, ledger, opts) => oneShot({ model: taskModel, spend }, params, ledger, opts),
        stream: (params, handlers) => taskModel.stream(params, handlers),
        name: modelName,
      }),
      spend: () => ({
        summary: () => spend.summary(),
        check: (usd, task) => spend.check(usd, task),
        hold: (usd, task) => spend.hold(usd, task),
        record: (entry) => spend.recordResponse(entry),
        treeSpend: (taskId) => spend.treeSpend(taskId),
        byPurpose: (days) => spend.byPurpose(days),
        ceiling: requestCeiling,
      }),
      memory: () => ({
        readOrNull: (path) => memory.readOrNull(path),
        log: (limit) => memory.log(limit),
        exists: (path) => memory.exists(path),
        create: async (path, content, botId, message) => {
          try {
            await memory.writeIf(path, content, "", bots.author(botId), message);
            return true;
          } catch (err) {
            if (err instanceof MemoryConflict) return false;
            throw err;
          }
        },
      }),
      storage: () => ({ line: async () => storageLine(await storage.measure()) }),
      skills: () => ({
        exists: (name) => memory.exists(skillPath(name)),
        save: (name, content) => skills.save(name, content, settings.get().owner),
      }),
      plugins: () => ({
        list: () => plugins.list(),
        tools: (only) => plugins.tools(only ?? null),
        signals: () => plugins.signals(),
        readyFor: (id, bot) => plugins.readyFor(id, bot.plugins, bots.leftToOthers(bot)),
        ownerOf: (tool) => {
          const p = plugins.pluginOf(tool);
          return (p && plugins.list().find((x) => x.id === p.id)) ?? null;
        },
      }),
    } satisfies { [K in keyof Hosts]: () => Hosts[K] },
  });
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
    negotiations,
  });

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
    auth,
    loginLimits,
    tasks,
    installer,
    restart: o.restart ?? (() => {}),
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
