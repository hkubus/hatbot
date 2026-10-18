// hatbox-agent: runs on the boxes guest, takes orders only from the brain (PLAN.md §21.6). It keeps,
// builds and runs boxes' backends; each runs as a unit of its own, with no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Guest } from "./guest";
import { MAX_UPDATE_BYTES, routes } from "./routes";
import { LocalUnits, SystemdUnits } from "./units";

const token = process.env.HATBOX_AGENT_TOKEN ?? "";
if (token.length < 32) throw new Error("HATBOX_AGENT_TOKEN is missing or too short");
const [host, port] = (process.env.HATBOX_LISTEN ?? "127.0.0.1:7071").split(":");
/** Set by systemd's StateDirectory= and RuntimeDirectory=. */
const state = process.env.STATE_DIRECTORY ?? join(import.meta.dir, "../.state");
const run = process.env.RUNTIME_DIRECTORY ?? join(state, "run");

const version = (() => {
  try {
    return readFileSync(join(import.meta.dir, "../VERSION"), "utf8").trim();
  } catch {
    return undefined;
  }
})();

const local = process.env.HATBOX_UNITS === "local";
if (local)
  console.error(
    "HATBOX_UNITS=local: backends run as this user, with its network, and could ask for each other's secrets",
  );
const guest = new Guest({
  state,
  run,
  units: local ? new LocalUnits(state, run) : new SystemdUnits(),
});
await guest.stopAll();
setInterval(() => guest.sweep().catch((err) => console.error("sweep:", err)), 60_000);

Bun.serve({
  hostname: host,
  port: Number(port),
  // A build or a backend's answer takes longer than Bun's default 10 seconds.
  idleTimeout: 0,
  maxRequestBodySize: MAX_UPDATE_BYTES,
  fetch: routes(guest, {
    token,
    version,
    updates: process.env.STATE_DIRECTORY ? state : undefined,
  }),
});
console.log(`hatbox-agent listening on ${host}:${port}`);
