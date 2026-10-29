import type { Proxmox } from "@hatbot/plugin-proxmox/client";
import type { Chats } from "./agent/chats";
import type { Models } from "./agent/models";
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
import type { ListingPhotos } from "./listing-photos";
import type { Proposals } from "./memory/proposals";
import type { MemoryStore } from "./memory/store";
import type { Negotiations } from "./negotiate/service";
import type { Plugins } from "./plugins/registry";
import type { Questions } from "./questions";
import type { Secrets } from "./secrets";
import type { SettingsStore } from "./settings";
import type { Spend } from "./spend";
import type { Tasks } from "./tasks/service";
import type { Teach } from "./teach/service";
import type { Updates } from "./updates";

export type Deps = {
  config: Config;
  db: Db;
  auth: AuthService;
  /** Global too, because TOTP is only 6 digits. */
  loginLimits: { perIp: FailureLimiter; global: FailureLimiter };
  events: EventBus;
  settings: SettingsStore;
  spend: Spend;
  memory: MemoryStore;
  chats: Chats;
  bots: Bots;
  tasks: Tasks;
  approvals: Approvals;
  questions: Questions;
  desktop: Desktop;
  archive: Archive;
  attachments: Attachments;
  listingPhotos: ListingPhotos;
  /** A function because Settings can change it. */
  proxmox: () => Proxmox;
  updates: Updates;
  proposals: Proposals;
  plugins: Plugins;
  teach: Teach;
  checks: Checks;
  negotiations: Negotiations;
  secrets: Secrets;
  models: Models;
};

export type AppEnv = {
  Variables: Deps & { principal: Principal; clientIp: string };
};
