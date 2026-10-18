import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db";

/** Compares a secret someone sent with the right one, in the same time whatever they sent. */
export const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A random key kept in settings under `name`, made the first time it's asked for. */
export function secretKey(db: Db, name: string): Buffer {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING").run(
    name,
    randomBytes(32).toString("hex"),
  );
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(name);
  return Buffer.from(row?.value ?? "", "hex");
}
