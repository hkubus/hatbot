// Forgets the owner's password and authenticator, for when you've lost them; infra/reset-login.sh runs
// it as the brain's user. Every browser and app is signed out, and the brain prints a new setup code
// when it next starts.
import { loadConfig } from "./config";
import { type Db, openDb } from "./db";

export function resetLogin(db: Db) {
  db.transaction(() => {
    db.query("DELETE FROM owner").run();
    db.query("DELETE FROM sessions").run();
    db.query("DELETE FROM api_tokens").run();
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
