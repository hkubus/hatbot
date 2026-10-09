import type { Thread } from "./agent/thread";
import type { AuthService, FailureLimiter, Principal } from "./auth/service";
import type { Config } from "./config";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { MemoryStore } from "./memory/store";
import type { SettingsStore } from "./settings";
import type { Spend } from "./spend";

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
};

export type AppEnv = {
  Variables: Deps & { principal: Principal; clientIp: string };
};
