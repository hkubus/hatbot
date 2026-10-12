import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file } from "../src/shell";

test("files go into the shell's home and come back out", async () => {
  const home = mkdtempSync(join(tmpdir(), "hatbot-shell-"));
  try {
    const url = (path: string) => `http://shell/files?path=${encodeURIComponent(path)}`;
    const put = await file(new Request(url("in/1-a.csv"), { method: "PUT", body: "1,2" }), home);
    expect(await put.json()).toEqual({ path: join(home, "in/1-a.csv") });
    const got = await file(new Request(url("in/1-a.csv")), home);
    expect(await got.text()).toBe("1,2");
    expect((await file(new Request(url("nope.txt")), home)).status).toBe(404);
    expect((await file(new Request("http://shell/files"), home)).status).toBe(400);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
