import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, MAX_FILE_BYTES, readUpTo } from "../src/shell";

const root = mkdtempSync(join(tmpdir(), "hatbot-shell-"));
const home = join(root, "home");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const url = (path: string) => `http://shell/files?path=${encodeURIComponent(path)}`;
const put = (
  path: string,
  body: ReadableStream<Uint8Array> | string = "x",
  headers: Record<string, string> = {},
) => file(new Request(url(path), { method: "PUT", body, headers }), home);

test("files go into the shell's home and come out of it, and nowhere else", async () => {
  expect(await (await put("in/1-a.csv", "1,2")).json()).toEqual({ path: join(home, "in/1-a.csv") });
  expect(await (await file(new Request(url("in/1-a.csv")), home)).text()).toBe("1,2");
  // A name that only starts with two dots is still inside.
  expect((await put("..notes")).status).toBe(200);
  for (const path of ["../outside.txt", "/etc/passwd", "..", "."])
    expect([path, (await put(path)).status]).toEqual([path, 400]);
  expect((await file(new Request(url("/etc/passwd")), home)).status).toBe(400);
  expect(existsSync(join(root, "outside.txt"))).toBe(false);
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
  const req = (body: ReadableStream<Uint8Array> | string, headers: Record<string, string> = {}) =>
    new Request("http://shell/files", { method: "PUT", body, headers });
  expect(await readUpTo(req(endless()), 10)).toBeNull();
  expect(pulled).toBeLessThan(10);
  // A declared size over the limit isn't read at all.
  pulled = 0;
  expect(await readUpTo(req(endless(), { "content-length": "100" }), 10)).toBeNull();
  expect(pulled).toBeLessThan(2);
  expect(await readUpTo(req("abc"), 10)).toEqual(new Uint8Array([97, 98, 99]));
  // The shell's file route applies it.
  const big = await put("big.bin", endless(), { "content-length": String(MAX_FILE_BYTES + 1) });
  expect(big.status).toBe(413);
});
