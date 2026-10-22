// infra/reset-login.sh runs this as the brain's user; the brain prints a new setup code when it next starts.
import { loadConfig } from "./config";
import { type Db, openDb } from "./db";

export function resetLogin(db: Db) {
  db.transaction(() => {
    db.query("DELETE FROM owner").run();
    db.query("DELETE FROM sessions").run();
    db.query("DELETE FROM api_tokens").run();
    // The key that marks browsers that signed in before: someone else's would keep its own limit.
    db.query("DELETE FROM settings WHERE key = 'device_key'").run();
  })();
}

if (import.meta.main) {
  const db = openDb(loadConfig().dbPath);
  resetLogin(db);
  db.close();
  console.log(
    "The password and authenticator are forgotten, and every browser and app signed out.",
  );
}
