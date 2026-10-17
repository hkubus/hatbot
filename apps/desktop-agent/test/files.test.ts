import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, MAX_FILE_BYTES, readUpTo } from "../src/shell";

const url = (path: string) => `http://shell/files?path=${encodeURIComponent(path)}`;

test("files go into the shell's home and come back out", async () => {
  const home = mkdtempSync(join(tmpdir(), "hatbot-shell-"));
  try {
    const put = await file(new Request(url("in/1-a.csv"), { method: "PUT", body: "1,2" }), home);
    expect(await put.json()).toEqual({ path: join(home, "in/1-a.csv") });
    const got = await file(new Request(url("in/1-a.csv")), home);
    expect(await got.text()).toBe("1,2");
    expect((await file(new Request(url("nope.txt")), home)).status).toBe(404);
    expect((await file(new Request("http://shell/files"), home)).status).toBe(400);
    // A name that only starts with two dots is still inside.
    expect(
      (await file(new Request(url("..notes"), { method: "PUT", body: "x" }), home)).status,
    ).toBe(200);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path that leaves the shell's home is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "hatbot-shell-"));
  const home = join(root, "home");
  try {
    for (const path of ["../outside.txt", "in/../../outside.txt", "/etc/passwd", "..", "."]) {
      const put = await file(new Request(url(path), { method: "PUT", body: "x" }), home);
      expect([path, put.status]).toEqual([path, 400]);
      const got = await file(new Request(url(path)), home);
      expect([path, got.status]).toEqual([path, 400]);
    }
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a body is read only up to its limit", async () => {
  let pulled = 0;
  const endless = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(4));
      },
    });
  const put = (body: ReadableStream<Uint8Array> | string, headers: Record<string, string> = {}) =>
    new Request("http://shell/files", { method: "PUT", body, headers });
  expect(await readUpTo(put(endless()), 10)).toBeNull();
  expect(pulled).toBeLessThan(10);
  // A declared size over the limit isn't read at all.
  pulled = 0;
  expect(await readUpTo(put(endless(), { "content-length": "100" }), 10)).toBeNull();
  expect(pulled).toBeLessThan(2);
  expect(await readUpTo(put("abc"), 10)).toEqual(new Uint8Array([97, 98, 99]));
  expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
});
