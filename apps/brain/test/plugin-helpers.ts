// Shared by the plugin tests: an app with one plugin switched on, its tools, call contexts, and a
// stand-in for the HTTP API a plugin talks to.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@hatbot/shared";
import type { CallContext, Plugin, PluginTool } from "../src/plugins/plugin";
import { FakeModel, toolUse } from "./fake-model";
import { type TestApp, tempDirs, testApp, waitFor } from "./helpers";

/** A call from a task that hasn't read untrusted content, and one that has. */
export const call: CallContext = {
  task: { id: 1, tainted: false },
  signal: new AbortController().signal,
};
export const tainted: CallContext = { ...call, task: { id: 1, tainted: true } };

/** The fingerprint of fixtures/pve-cert.pem, which the Proxmox and backup server stand-ins use. */
export const PVE_FINGERPRINT =
  "D7:6A:C1:55:98:6E:33:E6:73:98:B6:92:28:50:A5:F7:F0:69:D9:96:AD:CC:64:25:0D:DA:0F:BC:7A:4C:40:D0";
export const fixtures = join(import.meta.dir, "fixtures");

/** A temporary directory, removed after the run. */
export function tempDir(prefix = "hatbot-test-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** The plugin tool named `name` that `t` offers now. */
export function toolOf(t: TestApp, name: string): PluginTool {
  const found = t.plugins.tools().find((x) => x.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const running: TestApp[] = [];

/**
 * A test app with `plugin` switched on. `chat` answers the chat; `work` answers tasks. Call
 * stopPluginsAfterEach() in the file so its plugins stop even when a test fails.
 */
export async function pluginApp(
  plugin: Plugin,
  env: Record<string, string> = {},
  opts: { config?: unknown; chat?: FakeModel; work?: FakeModel } = {},
) {
  const t = await testApp(
    opts.chat ?? new FakeModel(),
    opts.work ?? new FakeModel(),
    {},
    [plugin],
    env,
  );
  running.push(t);
  const info = await t.plugins.update(plugin.id, {
    enabled: true,
    ...(opts.config === undefined ? {} : { config: opts.config }),
  });
  return Object.assign(t, { info, tool: (name: string) => toolOf(t, name) });
}

/** Stops the plugins of every app pluginApp() made, after each test of the file that calls this. */
export function stopPluginsAfterEach() {
  afterEach(async () => {
    for (const t of running.splice(0)) await t.plugins.stopAll();
  });
}

/** A scripted reply that ends a task. */
export const finish = (summary = "Done.") => ({
  content: [toolUse("finish_task", { outcome: "done", summary, notify: false })],
});

/** Starts a scheduled background task, which the work model runs. */
export const scheduled = (t: TestApp, goal = "Do it") =>
  t.tasks.createBackgroundTask({
    title: goal,
    goal,
    origin: "schedule",
    source: "s",
    runKey: `s:${Math.random()}`,
  }) as Task;

/** Waits for a task to end. */
export const ended = (t: TestApp, id: number) =>
  waitFor(() => {
    const task = t.tasks.get(id);
    return task?.finishedAt ? task : null;
  }, 5000);

export type Seen = { method: string; path: string; auth: string | null; body: string };

/**
 * A stand-in for a plugin's HTTP API, for the whole test file: it records each request (cleared
 * before each test) and answers with what `handle` returns, as JSON unless it's a Response.
 * `tls` names a certificate in fixtures/, e.g. "pve" for pve-cert.pem and pve-key.pem.
 */
export function fakeApi(
  handle: (req: Request, url: URL, body: string) => unknown,
  opts: { tls?: string } = {},
) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    ...(opts.tls
      ? {
          tls: {
            cert: Bun.file(join(fixtures, `${opts.tls}-cert.pem`)),
            key: Bun.file(join(fixtures, `${opts.tls}-key.pem`)),
          },
        }
      : {}),
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        body,
      });
      const out = await handle(req, url, body);
      return out instanceof Response ? out : Response.json(out ?? null);
    },
  });
  beforeEach(() => {
    seen.length = 0;
  });
  afterAll(() => server.stop(true));
  return {
    url: `${opts.tls ? "https" : "http"}://127.0.0.1:${server.port}`,
    port: Number(server.port),
    seen,
  };
}
