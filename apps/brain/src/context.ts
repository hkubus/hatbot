import type { AuthService, FailureLimiter, Principal } from "./auth/service";
import type { Config } from "./config";
import type { Db } from "./db";

export type Deps = {
  config: Config;
  db: Db;
  auth: AuthService;
  /** Failed logins: per client address, and across all addresses (TOTP is only 6 digits). */
  loginLimits: { perIp: FailureLimiter; global: FailureLimiter };
};

export type AppEnv = {
  Variables: Deps & { principal: Principal; clientIp: string };
};
