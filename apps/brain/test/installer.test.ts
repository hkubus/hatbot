import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInfo } from "@hatbot/shared";
import { pluginIndex } from "../src/plugins/installer";
import { FakeModel, text } from "./fake-model";
import { signIn, type TestApp, tempDirs, testApp, waitFor } from "./helpers";
import { finish, scheduled, stopPluginsAfterEach, track } from "./plugin-helpers";

stopPluginsAfterEach();

const PLUGIN = (
  id = "hello",
  sdk = 1,
  more = "",
  migration = `CREATE TABLE ${id}_notes (text TEXT NOT NULL)`,
) => `import { definePlugin, ready, tool, z } from "@hatbot/plugin-sdk";

export default definePlugin({
  id: "${id}",
  name: "Hello",
  description: "Says hello",
  sdk: ${sdk},
  env: [{ name: "HELLO_TOKEN", secret: true, optional: true }],
  config: z.object({ greeting: z.string().default("hi") }),
  migrations: [${JSON.stringify(migration)}],${more}
  tables: ["${id}_notes"],
  start: ({ config }) =>
    ready([
      tool({
        name: "${id}_greet",
        description: "Greets",
        access: "read",
        schema: z.object({}),
        run: async () => config.greeting,
      }),
    ]),
});
`;

const git = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};

/** A repository on this machine holding `files`, and its commit. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-plugin-repo-"));
  tempDirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "plugin");
  return { url: dir, commit: git(dir, "rev-parse", "HEAD") };
}

const helloRepo = (id = "hello", sdk = 1, more = "") =>
  repo({
    "package.json": JSON.stringify({
      name: `hatbot-plugin-${id}`,
      exports: { ".": "./src/index.ts" },
      dependencies: { "@hatbot/plugin-sdk": "workspace:*" },
    }),
    "src/index.ts": PLUGIN(id, sdk, more),
  });

const app = (more = {}, work = new FakeModel()) =>
  testApp(new FakeModel(), work, {}, [], {}, { localInstalls: true, ...more });

const install = (t: TestApp, body: { url: string; commit: string }) =>
  t.call("POST", "/plugins/install", body, signIn(t));

/** The same brain started again, as after an install. */
const restarted = (t: TestApp) => app({ config: t.config, db: t.db }).then(track);

const info = async (t: TestApp, id: string) =>
  (await (await t.call("GET", `/plugins/${id}`, undefined, signIn(t))).json()) as PluginInfo;

test("a plugin installed from git at a commit loads when the brain starts again", async () => {
  const t = track(await app());
  const r = helloRepo();
  const res = await install(t, r);
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: "hello", name: "Hello" });
  expect(t.restarts).toBe(1);
  expect(t.plugins.get("hello")).toBeNull();

  const again = await restarted(t);
  const hello = await info(again, "hello");
  expect(hello.source).toEqual({ url: r.url, commit: r.commit });
  await again.plugins.update("hello", { enabled: true });
  const on = await info(again, "hello");
  expect(on.state).toBe("ready");
  expect(on.tools.map((x) => x.name)).toEqual(["hello_greet"]);
});

test("installing refuses what isn't a plugin for this Hatbot", async () => {
  const t = track(await app());
  const ok = helloRepo();
  const refused = async (body: { url: string; commit: string }) => {
    const res = await install(t, body);
    expect(res.status).toBe(400);
    return ((await res.json()) as { error: string }).error;
  };
  expect(await refused({ url: ok.url, commit: "f".repeat(40) })).toBe(
    "That commit isn't in the repository.",
  );
  expect(await refused({ url: "http://example.com/x.git", commit: ok.commit })).toBe(
    "Give the repository's https address.",
  );
  expect(await refused({ url: ok.url, commit: "abc" })).toBe(
    "Give the commit's whole 40-character hash.",
  );
  expect(await refused(helloRepo("boxes"))).toBe(`There's a plugin called "boxes" already.`);
  expect(await refused(helloRepo("hello", 2))).toContain("version 2");
  expect(await refused(helloRepo("checks"))).toBe(`Its id, "checks", can't be used.`);
  expect(await refused(helloRepo("hello", 1, `routes: ["/schedules"],`))).toBe(
    "Automation answers /schedules already.",
  );
  expect(await refused(helloRepo("hello", 1, `provides: ["tasks"],`))).toBe(
    `Hatbot provides "tasks" itself.`,
  );
  expect(await refused(helloRepo("hello", 1, "internal: true,"))).toBe(
    "It says it's part of Hatbot.",
  );
  expect(await refused(repo({ "package.json": "{}", "src/index.ts": "export const x = 1;" }))).toBe(
    "It doesn't export a plugin.",
  );
  expect(t.restarts).toBe(0);
  expect(t.installer.list()).toEqual([]);
});

test("a git address on this machine is refused outside tests", async () => {
  const t = track(await app({ localInstalls: false }));
  const res = await install(t, helloRepo());
  expect(res.status).toBe(400);
});

test("nothing is installed while a task runs", async () => {
  let go = () => {};
  const work = new FakeModel([
    { content: [text("Working")], wait: new Promise<void>((r) => (go = r)) },
    finish(),
  ]);
  const t = track(await app({}, work));
  scheduled(t);
  await waitFor(() => work.requests.length);
  const res = await install(t, helloRepo());
  expect(res.status).toBe(409);
  expect(t.installer.list()).toEqual([]);
  go();
});

test("one that can't be loaded says why, and can still be uninstalled", async () => {
  const t = track(await app());
  await install(t, helloRepo());
  writeFileSync(join(t.config.dataDir, "installed", "hello", "src", "index.ts"), "throw 1;");
  const again = await restarted(t);
  await again.plugins.update("hello", { enabled: true });
  const hello = await info(again, "hello");
  expect(hello.state).toBe("error");
  expect(hello.message).toStartWith("It couldn't be loaded");
  const res = await again.call("DELETE", "/plugins/hello", undefined, signIn(again));
  expect(res.status).toBe(200);
  expect(again.installer.list()).toEqual([]);
});

test("one that can't run beside the rest doesn't stop the brain starting", async () => {
  // Changed under it after it was installed: a migration that fails, a path a built-in plugin answers.
  for (const [id, more, migration, why] of [
    ["hello", "", "NOT SQL", "It couldn't be loaded: near"],
    ["howdy", `routes: ["/schedules"],`, undefined, "It couldn't be loaded: Automation answers"],
  ] as const) {
    const t = track(await app());
    await install(t, helloRepo(id));
    const src = join(t.config.dataDir, "installed", id, "src", "index.ts");
    writeFileSync(src, PLUGIN(id, 1, more, migration));
    const again = await restarted(t);
    await again.plugins.update(id, { enabled: true });
    const hello = await info(again, id);
    expect(hello.state).toBe("error");
    expect(hello.message).toStartWith(why);
    expect((await again.call("DELETE", `/plugins/${id}`, undefined, signIn(again))).status).toBe(
      200,
    );
  }
});

test("uninstalling keeps what it kept; deleting its data clears it", async () => {
  const t = track(await app());
  await install(t, helloRepo());
  const again = await restarted(t);
  await again.plugins.update("hello", { enabled: true, config: { greeting: "hey" } });
  await again.plugins.setSecrets("hello", { HELLO_TOKEN: "s3cret" });
  again.db.query("INSERT INTO hello_notes (text) VALUES ('note')").run();
  const kept = join(again.config.dataDir, "plugins", "hello");
  mkdirSync(kept, { recursive: true });

  const builtIn = await again.call("DELETE", "/plugins/boxes", undefined, signIn(again));
  expect(builtIn.status).toBe(400);

  expect((await again.call("DELETE", "/plugins/hello", undefined, signIn(again))).status).toBe(200);
  expect(again.restarts).toBe(1);
  expect(existsSync(join(again.config.dataDir, "installed", "hello"))).toBe(false);
  expect(again.db.query("SELECT text FROM hello_notes").all()).toEqual([{ text: "note" }]);
  expect(again.secrets.pluginEnv().HELLO_TOKEN).toBe("s3cret");

  // Installed again, it finds what it had; then it goes with its data.
  await install(again, helloRepo());
  const third = await restarted(again);
  expect((await info(third, "hello")).config).toEqual({ greeting: "hey" });
  const res = await third.call("DELETE", "/plugins/hello?data=1", undefined, signIn(third));
  expect(res.status).toBe(200);
  expect(third.db.query("SELECT text FROM hello_notes").all()).toEqual([]);
  expect(third.secrets.pluginEnv().HELLO_TOKEN).toBeUndefined();
  expect(third.db.query("SELECT value FROM settings WHERE key = 'plugin:hello'").all()).toEqual([
    { value: '{"enabled":false}' },
  ]);
  expect(existsSync(kept)).toBe(false);
});

test("a plugin's data is deleted only while it's off", async () => {
  const t = track(await app());
  await t.plugins.update("boxes", { enabled: true });
  const on = await t.call("POST", "/plugins/boxes/forget", undefined, signIn(t));
  expect(on.status).toBe(400);
  await t.plugins.update("boxes", { enabled: false });
  const off = await t.call("POST", "/plugins/boxes/forget", undefined, signIn(t));
  expect(off.status).toBe(200);
  // On by default, it stays off after its data goes.
  expect((await info(await restarted(t), "boxes")).enabled).toBe(false);
});

test("plugins.json entries that aren't right are left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-index-"));
  tempDirs.push(dir);
  const good = {
    id: "hello",
    name: "Hello",
    description: "Says hello",
    url: "https://example.com/hello.git",
    commit: "a".repeat(40),
  };
  writeFileSync(join(dir, "plugins.json"), JSON.stringify([good, { ...good, commit: "main" }]));
  expect(pluginIndex(join(dir, "plugins.json"))).toEqual([good]);
  expect(pluginIndex()).toEqual([]);
});
