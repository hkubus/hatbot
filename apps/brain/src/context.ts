import type { Thread } from "./agent/thread";
import type { Approvals } from "./approvals";
import type { Archive } from "./archive";
import type { AuthService, FailureLimiter, Principal } from "./auth/service";
import type { Config } from "./config";
import type { Db } from "./db";
import type { Desktop } from "./desktop/service";
import type { EventBus } from "./events";
import type { MemoryStore } from "./memory/store";
import type { Proxmox } from "./proxmox";
import type { Schedules } from "./schedules";
import type { SettingsStore } from "./settings";
import type { Spend } from "./spend";
import type { Tasks } from "./tasks/service";
import type { Triggers } from "./triggers";
import type { Updates } from "./updates";

export type Deps = {
  config: Config;
  db: Db;
  auth: AuthService;
  /** Failed logins: per client address, and across all addresses (TOTP is only 6 digits). */
  loginLimits: { perIp: FailureLimiter; global: FailureLimiter };
  events: EventBus;
  settings: SettingsStore;
  spend: Spend;
  memory: MemoryStore;
  thread: Thread;
  tasks: Tasks;
  approvals: Approvals;
  desktop: Desktop;
  archive: Archive;
  proxmox: Proxmox;
  updates: Updates;
  schedules: Schedules;
  triggers: Triggers;
};

export type AppEnv = {
  Variables: Deps & { principal: Principal; clientIp: string };
};
