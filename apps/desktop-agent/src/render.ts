// Pages that fill in with JavaScript, for watchers: hatbot-render, its own systemd DynamicUser, loads one
// page at a time in a headless Chromium and gives back the DOM once the scripts ran. It isn't the bots'
// browser: a throwaway profile per page, so no logins, and no DevTools port. desktop-agent relays
// POST /render to its Unix socket. Chromium follows redirects and loads subresources itself, so only the
// address asked for is checked here, as /fetch checks it. What keeps a page off the LAN is the host
// firewall, and off Chromium's DevTools and desktop-agent the loopback rule for the DynamicUser range
// (desktop-deploy.sh).
import { chmodSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderResult } from "@hatbot/shared/desktop";
import { FetchError, MAX_FETCH_CHARS, readCapped, resolveHost, USER_AGENT, webUrl } from "./fetch";

export const RENDER_SOCKET = process.env.HATBOT_RENDER_SOCKET ?? "/run/hatbot-render/render.sock";
/** Chromium is killed after this, whatever it's doing. */
const KILL_AFTER_MS = 20_000;
/** Renders running or waiting their turn; past this the renderer is busy. */
const MAX_WAITING = 5;
/** Its script writes "rendered" after a wait that only virtual time makes short. */
const TEST_PAGE = `data:text/html,${encodeURIComponent(
  '<p id="t">waiting</p><script>setTimeout(() => { document.getElementById("t").textContent = "rendered"; }, 5000)</script>',
)}`;

export type RenderOptions = {
  /** Debian's binary is chromium. */
  chromium?: string;
  /** Throws a FetchError for a host that may not be rendered; tests replace the DNS check. */
  check?: (host: string) => Promise<unknown>;
  timeoutMs?: number;
};

/** The page at `target` after its scripts ran. Throws FetchError. */
export async function renderPage(target: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const url = webUrl(target);
  await (opts.check ?? ((host: string) => resolveHost(host, ownAddresses())))(url.hostname);
  const html = await dumpDom(url.href, opts);
  const failed = loadError(html);
  if (failed) throw new FetchError(`Couldn't load it: ${failed}.`, 502);
  return { html };
}

/** Renders a page of its own whose script writes its text: whether Chromium starts and runs scripts. */
export async function selfTest(opts: RenderOptions = {}): Promise<{ ok: true }> {
  const html = await dumpDom(TEST_PAGE, opts);
  if (!html.includes('<p id="t">rendered</p>'))
    throw new FetchError("Chromium ran, but the page's script didn't.", 500);
  return { ok: true };
}

/** Chromium's own page for a load that failed (refused, timed out): its error code. */
export function loadError(html: string): string | null {
  if (!/<body[^>]*\bclass="neterror"/.test(html)) return null;
  return /"errorCode":"([A-Z0-9_]+)"/.exec(html)?.[1] ?? "an error";
}

/**
 * The desktop's own addresses, which a page may not be on. Reading them needs netlink; without it the
 * loopback rule still keeps Chromium off them.
 */
function ownAddresses(): string[] {
  try {
    return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address));
  } catch {
    return [];
  }
}

/** Loads the page with its timers run ahead, so one that fills in after a wait is read at once. */
async function dumpDom(url: string, opts: RenderOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hatbot-render-"));
  const limit = opts.timeoutMs ?? KILL_AFTER_MS;
  const proc = Bun.spawn(
    [
      "setsid",
      opts.chromium ?? process.env.HATBOT_CHROMIUM ?? "chromium",
      "--headless=new",
      "--dump-dom",
      "--virtual-time-budget=15000",
      // A request that never ends (a long poll) doesn't hold the page back: it's read as it is then.
      `--timeout=${Math.max(1000, limit - 5000)}`,
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--disable-background-networking",
      "--disable-extensions",
      "--log-level=3",
      `--user-agent=${USER_AGENT}`,
      "--lang=en-GB",
      // Chromium's sandbox refuses root (tests, a dev machine); the service runs as its own user.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      url,
    ],
    {
      cwd: dir,
      // Nothing of the service's, and nothing kept: Chromium's caches and settings go in the profile.
      env: {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        XDG_CACHE_HOME: dir,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(proc.pid);
  }, limit);
  try {
    const [html, err, code] = await Promise.all([
      readCapped(new Response(proc.stdout)),
      tail(proc.stderr),
      proc.exited,
    ]);
    if (timedOut) throw new FetchError(`It didn't finish in ${limit / 1000} seconds.`, 504);
    if (code && !html.trim())
      throw new FetchError(
        `Chromium failed: ${err.trim().split("\n").at(-1) || `exit code ${code}`}`,
        500,
      );
    if (!html.trim()) throw new FetchError("Chromium gave back nothing.", 502);
    return html.slice(0, MAX_FETCH_CHARS);
  } finally {
    clearTimeout(timer);
    // Any helper process that outlived the browser.
    killGroup(proc.pid);
    await rm(dir, { recursive: true, force: true });
  }
}

/** setsid made Chromium its process group's leader. */
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** The last `max` characters of a stream: Chromium's last words when it fails. */
async function tail(stream: ReadableStream<Uint8Array>, max = 2000): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text = (text + decoder.decode(chunk, { stream: true })).slice(-max);
  return text;
}

let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;
/** One Chromium at a time: each takes a few hundred MB, and the unit has 500. */
export function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  if (waiting >= MAX_WAITING)
    return Promise.reject(new FetchError("The desktop is busy rendering other pages.", 429));
  waiting++;
  const p = chain.then(work).finally(() => {
    waiting--;
  });
  chain = p.catch(() => {});
  return p;
}

/** The socket's routes: POST /render with { url }, and POST /check. */
export async function handle(req: Request, opts: RenderOptions = {}): Promise<Response> {
  const route = `${req.method} ${new URL(req.url).pathname}`;
  try {
    if (route === "POST /render") {
      const { url } = (await req.json().catch(() => ({}))) as { url?: unknown };
      if (typeof url !== "string" || url.length > 2000)
        return Response.json({ error: "url must be a string" }, { status: 400 });
      return Response.json(await oneAtATime(() => renderPage(url, opts)));
    }
    if (route === "POST /check") return Response.json(await oneAtATime(() => selfTest(opts)));
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    if (err instanceof FetchError)
      return Response.json({ error: err.message }, { status: err.status });
    console.error(route, err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

if (import.meta.main) {
  rmSync(RENDER_SOCKET, { force: true });
  Bun.serve({ unix: RENDER_SOCKET, fetch: (req) => handle(req) });
  // desktop-agent runs as another user.
  chmodSync(RENDER_SOCKET, 0o666);
  console.log(`renderer on ${RENDER_SOCKET}`);
}
