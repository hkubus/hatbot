// A headless Chromium with DevTools on, for tests that drive browser.ts. CI may have none.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** $HATBOT_CHROMIUM, the system's, or Playwright's. */
function candidates(): string[] {
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright");
  return [
    process.env.HATBOT_CHROMIUM,
    ...["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].map((n) =>
      Bun.which(n),
    ),
    ...(existsSync(pw) ? readdirSync(pw) : [])
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse()
      .map((d) => join(pw, d, "chrome-linux/chrome")),
  ].filter((p): p is string => Boolean(p && existsSync(p)));
}

export type Chromium = { endpoint: string; stop: () => Promise<void> };

/** Starts one, and resolves with its DevTools address; null when none starts here. */
export async function startChromium(): Promise<Chromium | null> {
  for (const path of candidates()) {
    const dir = mkdtempSync(join(tmpdir(), "hatbot-cdp-"));
    const proc = Bun.spawn(
      [
        path,
        "--headless=new",
        "--remote-debugging-port=0",
        "--window-size=1280,800",
        `--user-data-dir=${dir}`,
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    // Its profile goes once it has exited: before that, it's still writing there.
    const stop = async () => {
      proc.kill("SIGKILL");
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    };
    const port = await listening(proc.stderr);
    if (port) return { endpoint: `http://127.0.0.1:${port}`, stop };
    await stop();
  }
  return null;
}

/** The port from "DevTools listening on ws://127.0.0.1:PORT/…", or null if it doesn't say within 15 s. */
async function listening(stderr: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => null),
    ]);
    if (!next || next.done) return null;
    seen += decoder.decode(next.value);
    const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(seen);
    if (m) {
      // Keep draining it: a closed pipe would end Chromium at its next log line.
      void (async () => {
        while (!(await reader.read().catch(() => ({ done: true }))).done) {}
      })();
      return m[1] ?? null;
    }
  }
  return null;
}
