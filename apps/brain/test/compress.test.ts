import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { pickEncoding } from "../src/compress";
import { webHandler } from "../src/web";
import { setUpOwner, tempDirs, testApp } from "./helpers";

test("the encoding is brotli where the client takes it, else gzip", () => {
  expect(pickEncoding("gzip, deflate, br")).toBe("br");
  expect(pickEncoding("gzip, br;q=0")).toBe("gzip");
  expect(pickEncoding("deflate")).toBeNull();
  expect(pickEncoding("*")).toBe("br");
  expect(pickEncoding("identity, *;q=0")).toBeNull();
  expect(pickEncoding(undefined)).toBeNull();
});

test("JSON answers come compressed; small ones and other types as they are", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  for (let i = 0; i < 30; i++) t.thread.addCard("text", `Message ${i}: ${"words ".repeat(40)}`, {});
  const get = (path: string, accept?: string) =>
    t.call("GET", path, undefined, { cookie, ...(accept ? { "accept-encoding": accept } : {}) });

  const plain = await get("/thread/messages");
  expect(plain.headers.get("content-encoding")).toBeNull();
  const json = await plain.text();
  expect(json.length).toBeGreaterThan(1024);

  const br = await get("/thread/messages", "gzip, deflate, br");
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("vary")).toContain("accept-encoding");
  const packed = new Uint8Array(await br.arrayBuffer());
  expect(packed.length).toBeLessThan(json.length / 3);
  expect(brotliDecompressSync(packed).toString()).toBe(json);

  const gz = await get("/thread/messages", "gzip");
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString()).toBe(json);

  const small = await get("/health", "br");
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(await small.json()).toMatchObject({ ok: true });
  // Errors keep their status.
  const missing = await get("/conversations/999/messages", "br");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "not found" });
});

test("a missing asset or file is a 404, not the app; routes still get the app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-web-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Hatbot</title>");
  writeFileSync(join(dir, "assets/index-NEW.js"), "console.log('new build');");
  const web = webHandler(dir);
  const get = (path: string) => web(new Request(`http://hatbot.test${path}`));

  // An older build's chunk, asked for by a tab opened before an update.
  for (const path of [
    "/assets/Memory-OLD.js",
    "/assets/index-OLD.css",
    "/assets/",
    "/favicon.ico",
    "/icon-1024.png",
    "/manifest.json",
  ]) {
    const res = get(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).not.toContain("<title>");
  }
  expect(await get("/assets/index-NEW.js").text()).toBe("console.log('new build');");
  for (const path of ["/", "/tasks/3", "/chat/2", "/bots/haggler", "/memory/teach/4"]) {
    const res = get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Hatbot</title>");
  }
});

test("the web app's files go out precompressed, and unchanged ones as a 304", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-web-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"));
  const js = "console.log('hatbot');".repeat(100);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Hatbot</title>");
  writeFileSync(join(dir, "assets/app.js"), js);
  writeFileSync(join(dir, "assets/app.js.br"), "BR");
  writeFileSync(join(dir, "assets/app.js.gz"), "GZ");
  const web = webHandler(dir);
  const get = (path: string, headers: Record<string, string> = {}) =>
    web(new Request(`http://hatbot.test${path}`, { headers }));

  const br = get("/assets/app.js", { "accept-encoding": "gzip, br" });
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("content-type")).toContain("javascript");
  expect(br.headers.get("cache-control")).toContain("immutable");
  expect(await br.text()).toBe("BR");
  expect(await get("/assets/app.js", { "accept-encoding": "gzip" }).text()).toBe("GZ");
  expect(await get("/assets/app.js").text()).toBe(js);

  // A copy older than its file is from an earlier build.
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "assets/app.js.br"), past, past);
  expect(await get("/assets/app.js", { "accept-encoding": "br" }).text()).toBe(js);

  const page = get("/tasks/3");
  expect(page.headers.get("cache-control")).toBe("no-cache");
  const etag = page.headers.get("etag") ?? "";
  expect(etag).toMatch(/^W\//);
  const again = get("/", { "if-none-match": etag });
  expect(again.status).toBe(304);
  expect(again.headers.get("content-security-policy")).toContain("default-src 'self'");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Hatbot 2</title>");
  expect(get("/", { "if-none-match": etag }).status).toBe(200);
  // A path that doesn't decode is a bad request, not an error page with a stack trace.
  const bad = get("/%E0%A4%A");
  expect(bad.status).toBe(400);
  expect(await bad.text()).toBe("Bad request");
});
