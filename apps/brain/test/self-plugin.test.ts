// Own code: Hatbot checks out its repository in the sandbox and proposes what changed as a pull request.
// The sandbox is a real directory and the Forgejo repository a local bare one, so git really runs.
import { beforeEach, expect, test } from "bun:test";
import { testApp } from "./helpers";
import {
  call,
  fakeApi,
  realSandbox,
  sh,
  stopPluginsAfterEach,
  tempDir,
  toolOf,
  track,
} from "./plugin-helpers";

stopPluginsAfterEach();

let pulls: Record<number, { login: string; ref: string }> = {};
const pull = (number: number) => {
  const p = pulls[number];
  return (
    p && {
      number,
      title: "Faster",
      body: "",
      state: "open",
      merged: false,
      user: { login: p.login },
      head: { ref: p.ref, repo: { full_name: "kubus/hatbot" } },
    }
  );
};
const forgejo = fakeApi((req, url) => {
  const path = url.pathname.replace("/api/v1/repos/kubus/hatbot", "");
  if (url.pathname === "/api/v1/user") return { login: "hatbot", email: "" };
  if (path === "") return { default_branch: "main" };
  if (req.method === "POST" && path === "/pulls")
    return { number: 7, html_url: "https://forge.test/kubus/hatbot/pulls/7" };
  if (path === "/pulls") return Object.keys(pulls).map((n) => pull(Number(n)));
  const n = Number(/^\/pulls\/(\d+)$/.exec(path)?.[1]);
  if (pull(n)) return pull(n);
  if (path === "/issues/12/comments")
    return req.method === "POST"
      ? {}
      : [{ user: { login: "kubus" }, body: "Say why.", created_at: "2026-10-18T10:00:00Z" }];
  if (path === "/pulls/12/reviews")
    return [
      {
        id: 3,
        user: { login: "kubus" },
        body: "",
        state: "REQUEST_CHANGES",
        submitted_at: "2026-10-18T11:00:00Z",
      },
    ];
  if (path === "/pulls/12/reviews/3/comments")
    return [{ path: "README.md", position: 1, body: "Name the speed-up." }];
  return new Response("not found", { status: 404 });
});
beforeEach(() => {
  pulls = {};
});

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
  const t = track(
    await testApp(undefined, undefined, {}, [], {
      FORGEJO_URL: forgejo.url,
      FORGEJO_TOKEN: "tok",
      HATBOT_SELF_REPO: "kubus/hatbot",
      HATBOT_SELF_GIT_URL: origin,
    }),
  );
  realSandbox(t);
  await t.plugins.update("self", { enabled: true });
  const run = (name: string, input: unknown) => toolOf(t, name).run(input, call);
  return { t, origin, seed, run };
}

/** The bot's open pull request #12, on hatbot/fix, a commit on main. */
function openPull12(seed: string, origin: string) {
  sh(
    seed,
    `git checkout -qb hatbot/fix && echo "Faster." >> README.md && git ${ID} commit -qam fix && git push -q ${origin} hatbot/fix && git checkout -q main`,
  );
  pulls[12] = { login: "hatbot", ref: "hatbot/fix" };
  return sh(origin, "git rev-parse hatbot/fix").output.trim();
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

test("review comments on its pull request come with the checkout, and the fix goes on top of its branch", async () => {
  const { origin, seed, run } = await setup();
  const head = openPull12(seed, origin);
  const out = await run("self_checkout", { pull: 12 });
  expect(out).toContain("hatbot/fix");
  expect(out).toContain("README.md:1: Name the speed-up.");

  await run("self_run", { command: "echo 'Twice as fast.' >> README.md", timeout_s: 30 });
  expect(
    await run("self_update", { pull: 12, message: "Name the speed-up\n\nRan bun test." }),
  ).toContain("Pushed");
  expect(sh(origin, "git rev-parse hatbot/fix^").output.trim()).toBe(head);
  expect(sh(origin, "git show hatbot/fix:README.md").output).toBe(
    "# Hatbot\nFaster.\nTwice as fast.\n",
  );
  expect(sh(origin, "git log -1 --format=%s hatbot/fix").output.trim()).toBe("Name the speed-up");
  const comment = forgejo.seen.find(
    (s) => s.method === "POST" && s.path.endsWith("/issues/12/comments"),
  );
  expect(JSON.parse(comment?.body ?? "{}").body).toStartWith("Name the speed-up");
});

test("someone else's pull request isn't checked out, and a branch that moved since isn't pushed to", async () => {
  const { origin, seed, run } = await setup();
  pulls[13] = { login: "kubus", ref: "hatbot/theirs" };
  await expect(run("self_checkout", { pull: 13 })).rejects.toThrow(
    "isn't one of your pull requests",
  );

  openPull12(seed, origin);
  await run("self_checkout", { pull: 12 });
  await run("self_run", { command: "echo 'Mine.' >> README.md", timeout_s: 30 });
  sh(
    seed,
    `git checkout -q hatbot/fix && echo "Theirs." >> README.md && git ${ID} commit -qam theirs && git push -q ${origin} hatbot/fix`,
  );
  const moved = sh(origin, "git rev-parse hatbot/fix").output.trim();
  await expect(run("self_update", { pull: 12, message: "Mine" })).rejects.toThrow(
    "Check out #12 again",
  );
  expect(sh(origin, "git rev-parse hatbot/fix").output.trim()).toBe(moved);
  expect(forgejo.seen.some((s) => s.method === "POST")).toBe(false);
});

test("suggestions run on a schedule set on the plugin's page, one open pull request at a time", async () => {
  const { t, origin, run } = await setup();
  const suggest = (every: string) =>
    t.plugins.action("self", "suggest", { every }) as Promise<{ id: number }>;
  const { id } = await suggest("weekly");
  expect(t.schedules.get(id)).toMatchObject({
    cron: "0 10 * * 1",
    createdVia: "owner",
    enabled: true,
  });
  expect((await suggest("monthly")).id).toBe(id);
  expect(t.schedules.get(id)?.cron).toBe("0 10 1 * *");

  pulls[20] = { login: "hatbot", ref: "hatbot/suggest/older" };
  expect(await run("self_checkout", {})).toContain("#20 hatbot/suggest/older");
  await run("self_run", { command: "echo 'Better.' >> README.md", timeout_s: 30 });
  await expect(
    run("self_propose", { branch: "hatbot/suggest/newer", title: "Better", body: "" }),
  ).rejects.toThrow("#20 is still open");
  expect(sh(origin, "git branch --list 'hatbot/*'").output).toBe("");

  await suggest("off");
  expect(t.schedules.get(id)).toBeNull();
  expect(await t.plugins.action("self", "suggestions", {})).toEqual({ every: "off" });
});
