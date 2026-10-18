import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateInfo } from "@hatbot/shared";
import { signIn, testApp } from "./helpers";

async function setup() {
  const t = await testApp();
  const { cookie } = signIn(t);
  const write = (name: string, body: unknown) =>
    writeFileSync(join(t.updateDir, name), JSON.stringify(body));
  const post = () => t.call("POST", "/update", undefined, { cookie });
  const get = async () =>
    (await (await t.call("GET", "/update", undefined, { cookie })).json()) as UpdateInfo;
  return { t, cookie, write, post, get };
}

const SOURCE = { url: "https://git.example/me/hatbot.git", branch: "main" };

test("Update asks hatbot-update by writing the request file, once at a time, and not while an update or a task runs", async () => {
  const { t, write, post, get } = await setup();
  // Off until deploy.sh sets a source.
  expect((await post()).status).toBe(503);
  write("source.json", SOURCE);
  // An update that's running, but not one that died long ago.
  write("status.json", {
    state: "running",
    step: "Fetching",
    startedAt: "2026-10-09T11:59:00Z",
    notes: [],
  });
  expect((await post()).status).toBe(409);
  t.advance(60 * 60_000);
  // The brain isn't restarted under a running task.
  t.db.run(
    "INSERT INTO tasks (title, goal, origin, lane, model, status, budget_usd) VALUES ('x', 'x', 'chat', 'screen', 'm', 'running', 1)",
  );
  expect((await post()).status).toBe(409);
  t.db.run("UPDATE tasks SET status = 'done'");
  expect((await post()).status).toBe(202);
  expect(existsSync(join(t.updateDir, "request"))).toBe(true);
  expect((await get()).requested).toBe(true);
  expect((await post()).status).toBe(409);
});

test("Check everything warns while Update deploys commits nobody signed, and about what's left to do by hand", async () => {
  const { t, write } = await setup();
  const check = async () => (await t.checks.run()).results.find((r) => r.id === "updates");
  const status = (notes: string[]) =>
    write("status.json", {
      state: "done",
      step: "Updated",
      startedAt: "2026-10-09T11:59:00Z",
      notes,
    });
  write("source.json", { ...SOURCE, signed: false });
  // An update that left a note to do by hand, as one without a desktop always does, says both.
  status(["The desktop isn't set up; only the brain was updated."]);
  const both = await check();
  expect(both?.state).toBe("warn");
  expect(both?.detail).toContain("whoever can push to it can run code on the brain");
  expect(both?.detail).toContain("The desktop isn't set up");
  status([]);
  write("source.json", { ...SOURCE, signed: true });
  expect((await check())?.state).toBe("ok");
  // An older brain-deploy.sh doesn't say, which isn't taken for either.
  write("source.json", SOURCE);
  expect((await check())?.state).toBe("ok");
});

/** What hatbot-update.sh needs of jq, for machines without it. */
const JQ_STAND_IN = `#!/usr/bin/env bun
const a = process.argv.slice(2);
const arg: Record<string, string> = {};
for (let i = 0; i < a.length; i++)
  if (a[i] === "--arg" || a[i] === "--argjson") arg[a[i + 1] ?? ""] = a[(i += 2)] ?? "";
if (a.includes("-n")) console.log(JSON.stringify({ state: arg.state, step: arg.step, error: arg.error }));
else if (a.includes(".sha // empty")) {
  try { console.log(JSON.parse(await Bun.file(a.at(-1) ?? "").text()).sha ?? ""); } catch {}
} else console.log(JSON.stringify([...JSON.parse(await Bun.stdin.text()), arg.n]));
`;

test("hatbot-update.sh deploys signed commits only forward, not a branch moved back", () => {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-update-"));
  try {
    const run = (cmd: string[], cwd = dir) => {
      const p = Bun.spawnSync(cmd, { cwd });
      if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    // Your signing key, and a repository with two commits signed with it.
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, "key")]);
    const pub = readFileSync(join(dir, "key.pub"), "utf8").trim();
    mkdirSync(join(dir, "etc"));
    writeFileSync(join(dir, "etc/allowed_signers"), `owner@example.com namespaces="git" ${pub}\n`);
    const remote = join(dir, "remote");
    mkdirSync(join(remote, "apps/desktop-agent"), { recursive: true });
    mkdirSync(join(remote, "infra"));
    writeFileSync(join(remote, "apps/desktop-agent/x"), "");
    writeFileSync(join(remote, "infra/brain-deploy.sh"), "");
    const repo = (...args: string[]) =>
      run(
        [
          "git",
          "-c",
          "user.name=Owner",
          "-c",
          "user.email=owner@example.com",
          "-c",
          "gpg.format=ssh",
          "-c",
          `user.signingkey=${join(dir, "key.pub")}`,
          ...args,
        ],
        remote,
      );
    repo("init", "-q", "-b", "main");
    const commit = (version: string) => {
      writeFileSync(join(remote, "VERSION"), version);
      repo("add", "-A");
      repo("commit", "-q", "-S", "-m", version);
      return repo("rev-parse", "HEAD");
    };
    const v1 = commit("v1: before the fix");
    const v2 = commit("v2: the fix");
    // The brain's side: its settings, the live release, and a deploy that only says what it got.
    writeFileSync(
      join(dir, "etc/update.env"),
      `HATBOT_GIT_URL=${remote}\nHATBOT_GIT_BRANCH=main\nHATBOT_UPDATE_SIGNERS=${join(dir, "etc/allowed_signers")}\n`,
    );
    mkdirSync(join(dir, "app"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "deploy.sh"), `tar -xOf "$1" VERSION > ${join(dir, "DEPLOYED")}\n`);
    if (!Bun.which("jq")) writeFileSync(join(dir, "bin/jq"), JQ_STAND_IN, { mode: 0o755 });
    const update = (live: string) => {
      writeFileSync(join(dir, "app/release.json"), JSON.stringify({ sha: live }));
      rmSync(join(dir, "DEPLOYED"), { force: true });
      Bun.spawnSync(["bash", join(import.meta.dir, "../../../infra/hatbot-update.sh")], {
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          HATBOT_UPDATE_STATE: join(dir, "state"),
          HATBOT_UPDATE_REQUEST: join(dir, "request"),
          HATBOT_APP: join(dir, "app"),
          HATBOT_ETC: join(dir, "etc"),
          HATBOT_BRAIN_DEPLOY: join(dir, "deploy.sh"),
        },
      });
      const deployed = join(dir, "DEPLOYED");
      return {
        status: JSON.parse(readFileSync(join(dir, "state/status.json"), "utf8")),
        deployed: existsSync(deployed) ? readFileSync(deployed, "utf8") : null,
      };
    };

    // Forward: deployed.
    expect(update(v1)).toMatchObject({ status: { state: "done" }, deployed: "v2: the fix" });
    // Someone with the forge account moves the branch back to the older signed commit.
    repo("reset", "-q", "--hard", v1);
    const back = update(v2);
    expect(back.deployed).toBeNull();
    expect(back.status.state).toBe("failed");
    expect(back.status.error).toContain("doesn't come after the live");
    // The same from an update repository that has never seen the live commit, as after deploy.sh.
    rmSync(join(dir, "state/repo.git"), { recursive: true });
    const unseen = update(v2);
    expect(unseen.deployed).toBeNull();
    expect(unseen.status.error).toContain("doesn't come after the live");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
