import { expect, test } from "bun:test";
import { clip, run } from "../src/shell";

test("a command's exit code and output, stderr marked; the environment is clean", async () => {
  process.env.HATBOT_SECRET_FOR_TEST = "leak";
  const r = await run(
    "echo out; echo err >&2; printenv HATBOT_SECRET_FOR_TEST || echo none; exit 3",
  ).finally(() => delete process.env.HATBOT_SECRET_FOR_TEST);
  expect(r).toEqual({ exitCode: 3, output: "out\nnone\n[stderr]\nerr", timedOut: false });
});

test("a command that runs too long is killed, children and all", async () => {
  const started = Date.now();
  const r = await run("sleep 30 & sleep 30", 1);
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("long output keeps its start and end", () => {
  const out = clip("a".repeat(50) + "b".repeat(50), 20);
  expect(out).toBe(`${"a".repeat(10)}\n… 80 characters left out …\n${"b".repeat(10)}`);
});
