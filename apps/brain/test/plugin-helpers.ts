// Shared by the plugin tests: an app with one plugin switched on, its tools, call contexts, and a
// stand-in for the HTTP API a plugin talks to.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallContext, Plugin, PluginTool } from "@hatbot/plugin-sdk";
import type { Task } from "@hatbot/shared";
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

export function tempDir(prefix = "hatbot-test-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** bash in `cwd`, away from the user's own git config. */
export function sh(cwd: string, script: string) {
  const p = Bun.spawnSync(["bash", "-c", script], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { exitCode: p.exitCode, output: `${p.stdout}${p.stderr}`, timedOut: false };
}

/** Makes `t`'s sandbox a real folder, which commands run in and files go in and out of. */
export function realSandbox(t: TestApp) {
  const box = tempDir("hatbot-sandbox-");
  t.agent.shell = (command) => sh(box, command);
  t.agent.putFile = async (path, bytes) => {
    mkdirSync(dirname(join(box, path)), { recursive: true });
    writeFileSync(join(box, path), bytes);
  };
  t.agent.getFile = async (path) => readFileSync(join(box, path));
  return box;
}

/** The plugins that ship with Hatbot switched on. */
export const ON_BY_DEFAULT = ["automation", "research", "boxes", "computer"];

/** The tools switched-on plugins give, without the core's own or those on by default. */
export const pluginTools = (t: TestApp): PluginTool[] =>
  t.plugins.tools().filter((x) => {
    const p = t.plugins.pluginOf(x.name);
    return !p?.internal && !ON_BY_DEFAULT.includes(p?.id ?? "");
  });

export function toolOf(t: TestApp, name: string): PluginTool {
  const found = t.plugins.tools().find((x) => x.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const running: TestApp[] = [];

/** Stops `t`'s plugins after the test, as pluginApp() does, for an app made another way. */
export function track<T extends TestApp>(t: T): T {
  running.push(t);
  return t;
}

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
  track(t);
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

export const ended = (t: TestApp, id: number) =>
  waitFor(() => {
    const task = t.tasks.get(id);
    return task?.finishedAt ? task : null;
  }, 5000);

export type Seen = { method: string; path: string; auth: string | null; body: string };

/**
 * A stand-in for a plugin's HTTP API, for the whole test file: it records each request (cleared
 * before each test) and answers with what `handle` returns, as JSON unless it's a Response. `raw` is
 * the body as it came. `tls` names a certificate in fixtures/, e.g. "pve" for pve-cert.pem and
 * pve-key.pem.
 */
export function fakeApi(
  handle: (req: Request, url: URL, body: string, raw: Uint8Array) => unknown,
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
      const raw = new Uint8Array(await req.arrayBuffer());
      const body = new TextDecoder().decode(raw);
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        body,
      });
      const out = await handle(req, url, body, raw);
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
