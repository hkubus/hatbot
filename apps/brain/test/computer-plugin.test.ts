import { afterEach, expect, test } from "bun:test";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { runPluginTool, verdictFor } from "../src/plugins/registry";
import { FakeComputer, withComputer } from "./fake-computer";
import { FakeModel, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";
import { call, ended, finish, scheduled, toolOf } from "./plugin-helpers";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function connected(t: TestApp, computer?: FakeComputer) {
  const c = await withComputer(t, computer);
  stops.push(c.stop);
  return c;
}

test("a computer connects with a device token, not a session; revoking the token cuts it off, and it keeps its name and switch when it comes back", async () => {
  const t = await testApp();
  const { computer, url, tokenId } = await connected(t);
  expect(t.computers.list()).toMatchObject([{ name: "laptop", online: true, enabled: true }]);
  const res = await t.call(
    "PATCH",
    "/computers/m-laptop",
    { name: "Work laptop", careful: true },
    signIn(t),
  );
  expect(await res.json()).toMatchObject({ name: "Work laptop", careful: true });

  const browser = new WebSocket(`${url}/api/v1/computer/connect`, {
    headers: { cookie: signIn(t).cookie, origin: "https://hatbot.test" },
  } as unknown as string[]);
  const refused = await new Promise((resolve) => {
    browser.onclose = () => resolve(true);
    browser.onopen = () => resolve(false);
  });
  expect(refused).toBe(true);

  t.auth.deleteToken(tokenId);
  await waitFor(() => computer.closed);
  await waitFor(() => !t.computers.find("m-laptop")?.online);

  const again = new FakeComputer();
  await connected(t, again);
  expect(t.computers.find("m-laptop")).toMatchObject({
    name: "Work laptop",
    careful: true,
    online: true,
  });
});

test("the web pauses a computer and turns it off, and the computer's own status says so; it can't be turned on from here", async () => {
  const t = await testApp();
  const { computer } = await connected(t);
  const owner = signIn(t);
  const paused = await t.call("POST", "/computers/m-laptop/pause", { paused: true }, owner);
  expect(paused.status).toBe(200);
  expect(computer.requests).toContainEqual({ op: "pause", paused: true });
  await waitFor(() => t.computers.find("laptop")?.paused);
  expect(t.events.some((e) => e.type === "computers" && e.computers[0]?.paused)).toBe(true);
  await t.call("POST", "/computers/m-laptop/turn-off", {}, owner);
  await waitFor(() => t.computers.find("laptop")?.enabled === false);
  expect((await t.call("POST", "/computers/m-laptop/turn-on", {}, owner)).status).toBe(404);
  // Take over is only for while a task is on it.
  expect((await t.call("POST", "/computers/m-laptop/takeover", {}, owner)).status).toBe(409);
});

test("commands: never sudo, nothing on a computer that's switched off, careful asks every time, and use asks once per task", async () => {
  const t = await testApp();
  await connected(t);
  const exec = toolOf(t, "computer_exec");
  const v = (command: string, c = call) => verdictFor(exec, { computer: "laptop", command }, c);
  expect(v("sudo apt upgrade").action).toBe("block");
  expect(v("ls; su -c id").action).toBe("block");
  expect(v("ls ~")).toMatchObject({ action: "ask", kind: "computer" });
  await runPluginTool(exec, { computer: "laptop", command: "ls ~" }, call);
  // Approved for this task now: everyday commands go ahead, destructive ones still ask.
  expect(v("ls ~").action).toBe("allow");
  expect(v("rm -rf ~/projects")).toMatchObject({ action: "ask", kind: "delete" });
  // Another task asks again.
  expect(v("ls ~", { ...call, task: { id: 2, tainted: false } }).action).toBe("ask");
  await t.call("PATCH", "/computers/m-laptop", { careful: true }, signIn(t));
  expect(v("ls ~")).toMatchObject({ action: "ask", careful: true });

  const off = new FakeComputer({
    ...new FakeComputer().hello,
    machineId: "m-pc",
    name: "pc",
    enabled: false,
  });
  await connected(t, off);
  expect(verdictFor(exec, { computer: "pc", command: "ls" }, call).action).toBe("block");
});

test("files: into Downloads/Hatbot freely, anywhere else asks; reading keys is refused, and what's read is untrusted", async () => {
  const t = await testApp();
  const { computer } = await connected(t);
  const put = toolOf(t, "computer_put_file");
  expect(verdictFor(put, { computer: "laptop", name: "a.txt", content: "x" }, call).action).toBe(
    "allow",
  );
  expect(
    verdictFor(put, { computer: "laptop", name: "a.txt", content: "x", path: "~/.bashrc" }, call),
  ).toMatchObject({ action: "ask", kind: "computer" });
  const r = await runPluginTool(put, { computer: "laptop", name: "a.txt", content: "hi" }, call);
  expect(r.content).toContain("/home/me/Downloads/Hatbot/a.txt");
  expect(computer.requests.at(-1)).toMatchObject({ op: "put_file", name: "a.txt" });

  const get = toolOf(t, "computer_get_file");
  const read = await runPluginTool(get, { computer: "laptop", path: "~/notes.txt" }, call);
  expect(read).toMatchObject({
    isError: false,
    untrusted: true,
    content: expect.stringContaining("hello"),
  });
  const key = await runPluginTool(get, { computer: "laptop", path: "~/.ssh/id_ed25519" }, call);
  expect(key.isError).toBe(true);
});

test("a task runs commands on the computer as the owner: using it is asked once, and after its output the review looks at the next", async () => {
  const exec = (command: string) => ({
    content: [toolUse("computer_exec", { computer: "laptop", command })],
  });
  const work = new FakeModel([exec("uname -a"), exec("df -h"), finish()]);
  work.onCreate = (p) =>
    p.system === REVIEW_PROMPT ? '{"safe": true, "why": "Routine."}' : undefined;
  const t = await testApp(new FakeModel(), work);
  const { computer } = await connected(t);
  const task = scheduled(t, "Check the laptop's disk");
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval).toMatchObject({ kind: "computer", summary: "On laptop: uname -a" });
  t.approvals.decide(approval.id, "approve", "web");
  const done = await ended(t, task.id);
  expect(work.creates.some((c) => c.system === REVIEW_PROMPT)).toBe(true);
  expect(t.approvals.list(true)).toHaveLength(0);
  expect(done).toMatchObject({ status: "done", tainted: true });
  expect(computer.requests.filter((r) => r.op === "exec")).toHaveLength(2);
});
