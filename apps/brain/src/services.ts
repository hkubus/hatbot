// Built the same way for the brain (main.ts) and for tests (test/helpers.ts): only the outside world
// is passed in.
import { join } from "node:path";
import { ACTIVE_TASK_STATUSES } from "@hatbot/shared";
import { Chats } from "./agent/chats";
import type { ModelClient } from "./agent/model";
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
import { Heartbeat } from "./heartbeat";
import { ListingPhotos } from "./listing-photos";
import { Listings } from "./listings/service";
import { Proposals } from "./memory/proposals";
import { MemoryStore } from "./memory/store";
import { Negotiations } from "./negotiate/service";
import { LinkingNotifier, type Notifier } from "./notify";
import { DeadManPing } from "./ping";
import { codePlugin } from "./plugins/code";
import type { Plugin } from "./plugins/plugin";
import { Plugins } from "./plugins/registry";
import { scoutPlugin } from "./plugins/scout";
import { selfPlugin } from "./plugins/self";
import { t3Plugin } from "./plugins/t3";
import { Proxmox } from "./proxmox";
import { Questions } from "./questions";
import { WeeklyReport } from "./report";
import { Schedules } from "./schedules";
import { Secrets } from "./secrets";
import { SettingsStore } from "./settings";
import { Spend } from "./spend";
import { Storage } from "./storage";
import { T3Code } from "./t3";
import { Tasks } from "./tasks/service";
import { Teach } from "./teach/service";
import { Skills } from "./teach/skills";
import { TodoReminders } from "./todo-reminders";
import { Triggers } from "./triggers";
import { Updates } from "./updates";
import { Watchers } from "./watch/service";

export type Outside = {
  config: Config;
  db: Db;
  clock?: () => number;
  model: ModelClient;
  taskModel: ModelClient;
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
  const t3 = new T3Code();
  const own = selfPlugin({
    desktop: agent,
    dir: join(config.dataDir, "self"),
    schedules: () => schedules,
  });
  const plugins = new Plugins(
    [
      ...o.plugins,
      codePlugin(files),
      t3Plugin({
        t3,
        db,
        publicUrl,
        saveToken: async (token) => {
          await plugins.setSecrets("t3", { T3_TOKEN: token });
        },
        fetch: o.fetch,
      }),
      scoutPlugin({
        publicUrl,
        saveToken: async (token) => {
          await plugins.setSecrets("scout", { SCOUT_TOKEN: token });
        },
        connected: () => {
          const haggler = bots.list().find((b) => b.name.toLowerCase() === "haggler");
          if (haggler?.plugins && !haggler.plugins.includes("scout"))
            bots.update(haggler.id, { plugins: [...haggler.plugins, "scout"] });
        },
        fetch: o.fetch,
      }),
      own,
    ],
    {
      db,
      events,
      env: o.pluginEnv,
      secrets,
      files,
      dataDir: config.dataDir,
      reserved: CORE_TOOL_NAMES,
    },
  );
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
    model: o.model,
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
    model: o.taskModel,
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
    t3,
  };
  const tasks = new Tasks({ ...core });
  events.on((e) => {
    if (e.type === "task.updated" && !ACTIVE_TASK_STATUSES.includes(e.task.status))
      t3.forget(`task-${e.task.id}`);
  });
  const teach = new Teach({ ...core, lane: tasks.lane });
  const schedules = new Schedules(db, events, settings, tasks, clock);
  const triggers = new Triggers(db, events, settings, tasks, notifier, publicUrl, clock);
  const watchers = new Watchers({ ...core, tasks, desktop: agent });
  const heartbeat = new Heartbeat({ ...core, tasks });
  const todoReminders = new TodoReminders({ ...core });
  const proposals = new Proposals({ ...core, tasks });
  const report = new WeeklyReport({ ...core });
  const negotiations = new Negotiations({ ...core, tasks });
  tasks.negotiations = negotiations;
  const listings = new Listings({ ...core, tasks });
  tasks.listings = listings;
  tasks.logins = new Logins({ ...core });
  chats.attach({
    tasks,
    schedules,
    triggers,
    watchers,
    approvals,
    attachments,
    desktop: agent,
    negotiations,
    proposals,
  });
  tasks.attach({ proposals });
  const feeds = new BoxFeeds({ db, settings, plugins, bots, clock });
  boxes.connect({ settings, spend, model: o.taskModel, chats, feeds, notifier, publicUrl });

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
    apiKeySet: () => Boolean(secrets.apiKey()),
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
    agent,
    auth,
    loginLimits,
    tasks,
    teach,
    schedules,
    triggers,
    watchers,
    heartbeat,
    todoReminders,
    proposals,
    report,
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
