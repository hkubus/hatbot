import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellJobStatus } from "@hatbot/shared/desktop";
import { jobs, run } from "../src/shell";

const home = mkdtempSync(join(tmpdir(), "hatbot-shell-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("a command's exit code and output, stderr marked; the environment is clean", async () => {
  process.env.HATBOT_SECRET_FOR_TEST = "leak";
  const r = await run(
    "echo out; echo err >&2; printenv HATBOT_SECRET_FOR_TEST || echo none; exit 3",
  ).finally(() => delete process.env.HATBOT_SECRET_FOR_TEST);
  expect(r).toEqual({ exitCode: 3, output: "out\nnone\n[stderr]\nerr", timedOut: false });
});

test("a job is read in whole lines as it goes; a stopped one is gone, with what it started", async () => {
  mkdirSync(join(home, "work"));
  const call = (method: string, path: string, body?: unknown) =>
    jobs(new Request(`http://shell${path}`, { method, body: JSON.stringify(body) }), home);
  const start = async (script: string) => {
    const res = await call("POST", "/jobs", {
      argv: ["bash", "-c", script],
      cwd: "work",
      timeoutS: 30,
    });
    return ((await res.json()) as { id: string }).id;
  };
  const read = async (id: string, from: number) =>
    (await (await call("GET", `/jobs/${id}?from=${from}`)).json()) as ShellJobStatus;
  const until = async <T>(fn: () => Promise<T | undefined>) => {
    const end = Date.now() + 4000;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(5);
    }
  };

  expect((await call("POST", "/jobs", { argv: ["true"], cwd: "..", timeoutS: 5 })).status).toBe(
    400,
  );

  // It ends its last line only once the test says so, to be read halfway.
  const a = await start(
    "printf 'one\\ntwo\\nthr'; until [ -e go ]; do sleep 0.01; done; echo ee; echo oops >&2; exit 3",
  );
  const halfway = await until(async () => {
    const s = await read(a, 0);
    return s.output.includes("two") ? s : undefined;
  });
  expect(halfway).toEqual({
    running: true,
    exitCode: null,
    timedOut: false,
    output: "one\ntwo\n",
    next: 8,
    stderr: "",
  });
  writeFileSync(join(home, "work/go"), "");
  const end = await until(async () => {
    const s = await read(a, 8);
    return s.running ? undefined : s;
  });
  expect(end).toEqual({
    running: false,
    exitCode: 3,
    timedOut: false,
    output: "three\n",
    next: 14,
    stderr: "oops\n",
  });

  const b = await start("sleep 30 & echo $!; wait");
  const pid = await until(async () => (await read(b, 0)).output.trim() || undefined);
  expect(await (await call("DELETE", `/jobs/${b}`)).json()).toEqual({});
  expect((await call("GET", `/jobs/${b}?from=0`)).status).toBe(410);
  // The sleep it left in the background is stopped too (a zombie is as good as gone).
  const gone = () => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ") || undefined;
    } catch {
      return true;
    }
  };
  await until(async () => gone());

  await call("DELETE", `/jobs/${a}`);
});
