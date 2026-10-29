// What the core gives plugins, by these names in `needs`: it's always there, so a plugin that needs
// only these never waits.
import type {
  AppSettings,
  Bot,
  CheckResult,
  Commit,
  HatbotEvent,
  PluginInfo,
  SearchResults,
  Task,
  TaskStep,
} from "@hatbot/shared";
import type {
  CreateParams,
  ModelMessage,
  ModelUsage,
  StreamHandlers,
  StreamParams,
} from "./models";

export const HOST_SERVICES = [
  "tasks",
  "chats",
  "bots",
  "notifier",
  "events",
  "settings",
  "model",
  "spend",
  "memory",
  "storage",
  "plugins",
] as const;

export type NtfyAction =
  | { action: "view"; label: string; url: string; clear?: boolean }
  | {
      action: "http";
      label: string;
      url: string;
      method: "POST";
      headers?: Record<string, string>;
      body: string;
      clear?: boolean;
    };

export type Notification = {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  click?: string;
  actions?: NtfyAction[];
};

export interface Notifier {
  send(n: Notification): Promise<void>;
}

/** What a task a restart stopped ends with. */
export const RESTARTED = "Stopped: the brain restarted.";

export type BackgroundTask = {
  title: string;
  goal: string;
  /** A plugin's own kinds of task are named in its `origins`. */
  origin: string;
  source?: string;
  scheduleId?: number;
  triggerId?: number;
  watcherId?: number;
  /** Null back while one with the same key still runs. */
  runKey?: string;
  /** The event that started it. Untrusted unless `trusted`: the task starts tainted. */
  payload?: string;
  trusted?: boolean;
  /** It starts tainted: what started it had read untrusted content, this. */
  taintedBy?: string | null;
  /** The bot doing it; Hatbot by default. */
  botId?: string;
  /** Started from the chat: where it reports, and the message it shows under. */
  conversationId?: number;
  message?: number;
  /** The owner's recent words, when they started it from the chat: what the approval review reads. */
  request?: string;
  /** The hand-off whose answer started it, so hand-offs through chats count towards the cap. */
  askedIn?: Task;
  /** A plugin's task runner, by name, that runs it in place of a task's loop. */
  runner?: string;
};

export interface TasksHost {
  createBackgroundTask(input: BackgroundTask): Task | null;
  get(id: number): Task | null;
  activeFor(runKey: string): Task | null;
  /** News for a running task, which it reads after its current step. */
  tell(id: number, event: string): void;
  addStep(
    id: number,
    step: { kind: TaskStep["kind"]; name: string; detail: string; url: string | null },
  ): TaskStep;
  steps(id: number): TaskStep[];
  taint(id: number, by: string): void;
  mark(id: number, flag: "injection_suspected"): void;
  /** Its tree's spend limit now, in USD. */
  budget(id: number): number;
  setReportPath(id: number, path: string): void;
}

export interface ChatsHost {
  /** A message from the bot in its own chat; `taintedBy`: it quotes what that wrote. */
  note(botId: string, text: string, taintedBy?: string | null): unknown;
}

export interface BotsHost {
  get(id: string): Bot | null;
  /** Null once it's deleted. */
  active(id: string): Bot | null;
  hatbot(): Bot;
  nameOf(id: string): string;
  list(): Bot[];
}

export interface EventsHost {
  emit(e: HatbotEvent): void;
  /** Returns what stops listening. */
  on(fn: (e: HatbotEvent) => void): () => void;
}

export interface SettingsHost {
  get(): AppSettings;
  update(patch: Pick<Partial<AppSettings>, "heartbeat">): unknown;
}

/** A task's spend limit, which a request is held against with the daily and monthly ones. */
export type TaskLimit = { id: number; limitUsd: number };

export interface ModelHost {
  /** One request to `params.model`, charged to the spend limits; its text, or it throws. */
  ask(
    params: CreateParams,
    ledger: { purpose: string; botId?: string; taskId?: number },
    opts?: { reserve?: boolean; task?: TaskLimit },
  ): Promise<string>;
  /** A request as it is, not charged: charge it with `spend.record`, and failed attempts too. */
  stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers): Promise<ModelMessage>;
  /** "Haiku 5.5" for its id. */
  name(id: string): string;
}

export interface SpendHost {
  summary(): {
    todayUsd: number;
    monthUsd: number;
    limits: { dailyUsd: number; monthlyUsd: number };
  };
  /** Throws BudgetError if `usd` more would pass a limit. */
  check(usd: number, task?: TaskLimit): void;
  /** Holds `usd` against the limits while a request is out; call what it returns once it's recorded. */
  hold(usd: number, task?: TaskLimit): () => void;
  record(entry: { model: string; purpose: string; usage: ModelUsage; taskId?: number }): void;
  /** What a task and the tasks it started have spent. */
  treeSpend(taskId: number): number;
  /** The most one request may cost. */
  ceiling(
    model: string,
    r: { prompt: number; write?: "5m" | "1h"; maxTokens: number; webSearches?: number },
  ): number;
}

export interface MemoryHost {
  readOrNull(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** A new file, written as `botId`; false if one is there already. */
  create(path: string, content: string, botId: string, message: string): Promise<boolean>;
  log(limit?: number): Promise<Commit[]>;
}

export interface StorageHost {
  /** What the data takes, in a line. */
  line(): Promise<string>;
}

export interface PluginsHost {
  list(): PluginInfo[];
  /** Ready tools, of the plugins in `only` when it's given. */
  tools(only?: string[] | null): import("./index").PluginTool[];
  /** What's wrong right now, the core's own (the desktop) and every plugin's. */
  signals(): Promise<import("./index").PluginSignal[]>;
}

/** A line in Check everything. */
export type PluginCheck = {
  id: string;
  name: string;
  run: () => Promise<Pick<CheckResult, "state" | "detail">>;
};

/**
 * A kind of background task a plugin starts. The core asks it, as the task runs, what the review may
 * take for the owner's words; without one, nothing is.
 */
export type TaskOrigin = {
  /** "the schedule "Backups"", after "Started by". */
  startedBy: (source: string) => string;
  /** The standing instructions the owner gave, as the approval review may read them; null if untrusted. */
  standing?: (task: Task) => string | null;
  /** Splits an event (its payload, or news told it later) into what's trusted and what isn't. */
  event?: (
    text: string,
  ) => { trusted: string; untrusted?: { source: string; text: string } } | null;
  /** It may spend what's kept back for alerts. */
  reserve?: boolean;
  /** What to tell the owner when a spend limit stops it. */
  overLimit?: (limit: "daily" | "monthly", task: Task) => string;
};

export type SearchRoutine = SearchResults["routines"][number];
