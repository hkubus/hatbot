// Own code: Hatbot checks out its repository in the sandbox and proposes what changed as a pull request.
// The sandbox is a real directory and the Forgejo repository a local bare one, so git really runs.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { testApp } from "./helpers";
import { call, fakeApi, stopPluginsAfterEach, tempDir, toolOf, track } from "./plugin-helpers";

stopPluginsAfterEach();

const forgejo = fakeApi((req, url) => {
  if (url.pathname === "/api/v1/user") return { login: "hatbot", email: "" };
  if (url.pathname === "/api/v1/repos/kubus/hatbot") return { default_branch: "main" };
  if (req.method === "POST" && url.pathname === "/api/v1/repos/kubus/hatbot/pulls")
    return { number: 7, html_url: "https://forge.test/kubus/hatbot/pulls/7" };
  return new Response("not found", { status: 404 });
});

/** git in `cwd`, away from the user's own config. */
function sh(cwd: string, script: string) {
  const p = Bun.spawnSync(["bash", "-c", script], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { exitCode: p.exitCode, output: `${p.stdout}${p.stderr}`, timedOut: false };
}
const ID = "-c user.name=Owner -c user.email=owner@test";

async function setup() {
  const origin = tempDir("hatbot-origin-");
  const seed = tempDir("hatbot-seed-");
  sh(
    seed,
    `set -e; git init -q -b main; echo "# Hatbot" > README.md; mkdir infra
     printf '#!/bin/sh\\necho deploy\\n' > infra/deploy.sh; chmod +x infra/deploy.sh
     git add -A; git ${ID} commit -qm init; git clone -q --bare . ${origin}`,
  );
  const box = tempDir("hatbot-sandbox-");
  const t = track(
    await testApp(undefined, undefined, {}, [], {
      FORGEJO_URL: forgejo.url,
      FORGEJO_TOKEN: "tok",
      HATBOT_SELF_REPO: "kubus/hatbot",
      HATBOT_SELF_GIT_URL: origin,
    }),
  );
  t.agent.shell = (command) => sh(box, command);
  t.agent.putFile = async (path, bytes) => {
    mkdirSync(dirname(join(box, path)), { recursive: true });
    writeFileSync(join(box, path), bytes);
  };
  t.agent.getFile = async (path) => readFileSync(join(box, path));
  await t.plugins.update("self", { enabled: true });
  const run = (name: string, input: unknown) => toolOf(t, name).run(input, call);
  return { t, origin, seed, run };
}

test("a change in the sandbox becomes a branch on the commit it came from, and a pull request that flags infra", async () => {
  const { origin, seed, run } = await setup();
  const before = sh(origin, "git rev-parse main").output.trim();
  expect(await run("self_checkout", {})).toContain("2 files in ~/hatbot-self/work");

  await run("self_run", {
    command: "echo 'Now faster.' >> README.md && echo 'echo again' >> infra/deploy.sh",
    timeout_s: 30,
  });
  // The default branch moves on meanwhile: the proposal mustn't undo it.
  sh(
    seed,
    `echo "# Hatbot!" > README.md && git ${ID} commit -qam moved && git push -q ${origin} main`,
  );

  const out = await run("self_propose", {
    branch: "hatbot/faster",
    title: "Faster",
    body: "Ran bun test: all pass.",
  });
  expect(out).toContain("Opened pull request #7");
  expect(sh(origin, "git rev-parse hatbot/faster^").output.trim()).toBe(before);
  expect(sh(origin, "git show hatbot/faster:README.md").output).toBe("# Hatbot\nNow faster.\n");
  // Applied as a diff, the script keeps its executable bit.
  expect(sh(origin, "git ls-tree hatbot/faster infra/deploy.sh").output).toStartWith("100755");
  expect(sh(origin, "git log -1 --format=%an hatbot/faster").output.trim()).toBe("hatbot");

  const opened = forgejo.seen.find((s) => s.method === "POST");
  const body = JSON.parse(opened?.body ?? "{}");
  expect(body).toMatchObject({ head: "hatbot/faster", base: "main", title: "Faster" });
  expect(body.body).toStartWith("Ran bun test: all pass.");
  expect(body.body).toContain("- `infra/deploy.sh`");
  expect(body.body).not.toContain("- `README.md`");
});

test("nothing changed, or a symlink, isn't proposed, and nothing is pushed", async () => {
  const { origin, run } = await setup();
  await run("self_checkout", {});
  const propose = () => run("self_propose", { branch: "hatbot/x", title: "X", body: "" });
  await expect(propose()).rejects.toThrow("Nothing changed");
  await run("self_run", { command: "ln -s /etc/passwd leak", timeout_s: 30 });
  await expect(propose()).rejects.toThrow("Symlinks and submodules can't be proposed: leak");
  expect(sh(origin, "git branch --list 'hatbot/*'").output).toBe("");
  expect(forgejo.seen.some((s) => s.method === "POST")).toBe(false);
});
