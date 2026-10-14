import type { Chats } from "./agent/chats";
import type { Approvals } from "./approvals";
import type { Archive } from "./archive";
import type { Attachments } from "./attachments";
import type { AuthService, FailureLimiter, Principal } from "./auth/service";
import type { Bots } from "./bots";
import type { Checks } from "./checks";
import type { Config } from "./config";
import type { Db } from "./db";
import type { Desktop } from "./desktop/service";
import type { EventBus } from "./events";
import type { MemoryStore } from "./memory/store";
import type { Plugins } from "./plugins/registry";
import type { Proxmox } from "./proxmox";
import type { Schedules } from "./schedules";
import type { SettingsStore } from "./settings";
import type { Spend } from "./spend";
import type { Tasks } from "./tasks/service";
import type { Teach } from "./teach/service";
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
  chats: Chats;
  bots: Bots;
  tasks: Tasks;
  approvals: Approvals;
  desktop: Desktop;
  archive: Archive;
  attachments: Attachments;
  proxmox: Proxmox;
  updates: Updates;
  schedules: Schedules;
  triggers: Triggers;
  plugins: Plugins;
  teach: Teach;
  checks: Checks;
};

export type AppEnv = {
  Variables: Deps & { principal: Principal; clientIp: string };
};
