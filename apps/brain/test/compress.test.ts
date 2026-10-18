import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webHandler } from "../src/web";
import { tempDirs } from "./helpers";

test("the web app's files go out precompressed, unchanged ones as a 304; a missing one is a 404, not the app", async () => {
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
  expect(br.headers.get("cache-control")).toContain("immutable");
  expect(await br.text()).toBe("BR");
  expect(await get("/assets/app.js", { "accept-encoding": "gzip" }).text()).toBe("GZ");
  expect(await get("/assets/app.js").text()).toBe(js);
  // A copy older than its file is from an earlier build.
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "assets/app.js.br"), past, past);
  expect(await get("/assets/app.js", { "accept-encoding": "br" }).text()).toBe(js);

  const page = get("/tasks/3");
  expect(await page.text()).toContain("<title>Hatbot</title>");
  const etag = page.headers.get("etag") ?? "";
  const again = get("/", { "if-none-match": etag });
  expect(again.status).toBe(304);
  expect(again.headers.get("content-security-policy")).toContain("default-src 'self'");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Hatbot 2</title>");
  expect(get("/", { "if-none-match": etag }).status).toBe(200);

  // An older build's chunk, asked for by a tab opened before an update.
  const old = get("/assets/Memory-OLD.js");
  expect(old.status).toBe(404);
  expect(old.headers.get("cache-control")).toBe("no-store");
  expect(await old.text()).not.toContain("<title>");
  expect(get("/favicon.ico").status).toBe(404);
  // A path that doesn't decode is a bad request, not an error page with a stack trace.
  expect(get("/%E0%A4%A").status).toBe(400);
});
