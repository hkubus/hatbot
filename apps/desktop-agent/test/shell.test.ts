import { expect, test } from "bun:test";
import { run } from "../src/shell";

test("a command's exit code and output, stderr marked; the environment is clean", async () => {
  process.env.HATBOT_SECRET_FOR_TEST = "leak";
  const r = await run(
    "echo out; echo err >&2; printenv HATBOT_SECRET_FOR_TEST || echo none; exit 3",
  ).finally(() => delete process.env.HATBOT_SECRET_FOR_TEST);
  expect(r).toEqual({ exitCode: 3, output: "out\nnone\n[stderr]\nerr", timedOut: false });
});
