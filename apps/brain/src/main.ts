import { createApp } from "./app";
import { AuthService, FailureLimiter } from "./auth/service";
import { loadConfig } from "./config";
import { openDb } from "./db";

const config = loadConfig();
const db = openDb(config.dbPath);
const auth = new AuthService(db);
const loginLimits = {
  perIp: new FailureLimiter(10, 15 * 60_000),
  global: new FailureLimiter(50, 15 * 60_000),
};

const app = createApp({ config, db, auth, loginLimits });
const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
console.log(`hatbot brain listening on http://${server.hostname}:${server.port}`);
if (!auth.isSetUp()) {
  console.log(`First run: open ${config.publicUrl}/setup and enter setup code ${auth.setupCode}`);
}
