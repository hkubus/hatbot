// Pages that fill in with JavaScript, for watchers: hatbot-render, its own systemd DynamicUser, loads one
// page at a time in a headless Chromium and gives back the DOM once the scripts ran. It isn't the bots'
// browser: a throwaway profile per page, so no logins, and no DevTools port. desktop-agent relays
// POST /render to its Unix socket. Chromium follows redirects and loads subresources itself, so only the
// address asked for is checked here, as /fetch checks it. What keeps a page off the LAN is the host
// firewall, and off Chromium's DevTools and desktop-agent the loopback rule for the DynamicUser range
// (desktop-deploy.sh).
//
// It also draws boxes' pages for box_look (POST /box, PLAN.md §21.12), from the page the brain sends and
// with no network at all: CSP doesn't stop a page leaving itself (location.href = "https://…/?" + data),
// and this user may reach the internet, which watchers need. So that Chromium gets a proxy that refuses
// every connection, loopback included, a resolver that resolves nothing, and WebRTC kept to the proxy,
// and DevTools (a pipe, not a port) serves the page and stops it leaving before any of that is reached.
import { chmodSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoxLook,
  type BoxLookError,
  type BoxLookResult,
  MAX_LOOK_ERRORS,
  MAX_LOOK_HEIGHT,
  type RenderResult,
} from "@hatbot/shared/desktop";
import { FetchError, readText, resolveHost, USER_AGENT, webUrl } from "./fetch";
import { DevToolsPipe } from "./pipe";

export const RENDER_SOCKET = process.env.HATBOT_RENDER_SOCKET ?? "/run/hatbot-render/render.sock";
/** Chromium is killed after this, whatever it's doing. */
const KILL_AFTER_MS = 20_000;
/** Renders running or waiting their turn; past this the renderer is busy. */
const MAX_WAITING = 5;
/** Its script writes "rendered" after a wait that only virtual time makes short. */
const TEST_PAGE = `data:text/html,${encodeURIComponent(
  '<p id="t">waiting</p><script>setTimeout(() => { document.getElementById("t").textContent = "rendered"; }, 5000)</script>',
)}`;

/** Where a box's page is served from: a name that never resolves, answered in DevTools. */
const BOX_URL = "https://box.hatbot.invalid/";
/** After a box's load event, for what its page does then (reading its store, a first draw). */
const SETTLE_MS = 500;
const MAX_BOX_PAGE = 12 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

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
      env: profileEnv(dir),
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
      readText(proc.stdout),
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
    return html;
  } finally {
    clearTimeout(timer);
    // Any helper process that outlived the browser.
    killGroup(proc.pid);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Nothing of the service's, and nothing kept: Chromium's caches and settings go in the profile. */
const profileEnv = (dir: string) => ({
  HOME: dir,
  XDG_CONFIG_HOME: dir,
  XDG_CACHE_HOME: dir,
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
});

/** Throws FetchError for a body that isn't a box to look at. */
export function boxLook(body: unknown): BoxLook {
  const b = (body ?? {}) as Partial<BoxLook>;
  const px = (n: unknown) => Number.isInteger(n) && (n as number) >= 200 && (n as number) <= 2000;
  if (typeof b.html !== "string" || typeof b.csp !== "string" || typeof b.dark !== "boolean")
    throw new FetchError("html, csp and dark are needed", 400);
  if (!px(b.width) || !px(b.height))
    throw new FetchError("width and height must be whole pixels, from 200 to 2000", 400);
  if (b.html.length > MAX_BOX_PAGE) throw new FetchError("The page is too big to render.", 413);
  return {
    html: b.html,
    csp: b.csp,
    width: Number(b.width),
    height: Number(b.height),
    dark: b.dark,
  };
}

/**
 * A box's page drawn at the screen size asked, once it has loaded and done what it does then, with the
 * errors it hit. Throws FetchError.
 */
export async function lookAtBox(look: BoxLook, opts: RenderOptions = {}): Promise<BoxLookResult> {
  const dir = await mkdtemp(join(tmpdir(), "hatbot-look-"));
  // Every connection to it ends at once. Under systemd the loopback rule resets them before that.
  const proxy = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open: (s) => void s.end(), data: () => {} },
  });
  const limit = opts.timeoutMs ?? KILL_AFTER_MS;
  const proc = Bun.spawn(
    [
      "setsid",
      opts.chromium ?? process.env.HATBOT_CHROMIUM ?? "chromium",
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${dir}`,
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      // Chromium sends loopback past a proxy unless told not to.
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      // WebRTC's UDP goes past any proxy; this keeps it to the proxy, which takes only TCP.
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--no-first-run",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--hide-scrollbars",
      "--mute-audio",
      "--log-level=3",
      "--lang=en-GB",
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    // DevTools on its fds 3 (to it) and 4 (from it).
    { cwd: dir, env: profileEnv(dir), stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  const [, , , to, from] = proc.stdio as unknown as number[];
  const cdp = new DevToolsPipe(to as number, from as number);
  const lastWords = tail(proc.stderr as ReadableStream<Uint8Array>);
  let timer: Timer | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new FetchError(`It didn't finish in ${limit / 1000} seconds.`, 504)),
      limit,
    );
  });
  const died = proc.exited.then(async (code): Promise<never> => {
    const err = (await lastWords).trim().split("\n").at(-1);
    throw new FetchError(`Chromium failed: ${err || `exit code ${code}`}`, 500);
  });
  died.catch(() => {});
  try {
    return await Promise.race([drawBox(cdp, look), timedOut, died]);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(`Chromium failed: ${(err as Error).message}`, 500);
  } finally {
    clearTimeout(timer);
    killGroup(proc.pid);
    await proc.exited;
    cdp.close();
    proxy.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}

async function drawBox(cdp: DevToolsPipe, look: BoxLook): Promise<BoxLookResult> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const page = <T>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
  // Answers go back without waiting: one for a page that has gone needs nothing.
  const answer = (method: string, params: object) => void page(method, params).catch(() => {});

  const errors: BoxLookError[] = [];
  const add = (message: string, line?: number) => {
    const text =
      message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…` : message;
    const same = errors.find((e) => e.message === text && e.line === line);
    if (same) same.count = (same.count ?? 1) + 1;
    else if (errors.length < MAX_LOOK_ERRORS)
      errors.push(line ? { message: text, line } : { message: text });
  };
  cdp.on("Runtime.exceptionThrown", (p) => {
    const d = (p as { exceptionDetails: ExceptionDetails }).exceptionDetails;
    const thrown = d.exception?.description?.split("\n")[0] ?? valueText(d.exception);
    add(thrown ? `${d.text} ${thrown}` : d.text, d.lineNumber + 1);
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    const c = p as ConsoleCall;
    if (c.type !== "error") return;
    const at = c.stackTrace?.callFrames[0]?.lineNumber;
    add(`console.error: ${c.args.map(valueText).join(" ")}`, at === undefined ? undefined : at + 1);
  });
  // The browser's own: a CSP refusal, a request that failed.
  cdp.on("Log.entryAdded", (p) => {
    const e = (p as { entry: { level: string; text: string; lineNumber?: number } }).entry;
    if (e.level === "error") add(e.text, e.lineNumber === undefined ? undefined : e.lineNumber + 1);
  });
  // The page comes from here. Leaving it is stopped where it starts, so the picture still shows the box;
  // anything else goes on to the proxy, which refuses it.
  cdp.on("Fetch.requestPaused", (p) => {
    const r = p as {
      requestId: string;
      request: { url: string };
      resourceType: string;
      frameId: string;
    };
    const requestId = r.requestId;
    if (r.request.url === BOX_URL)
      return answer("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "content-type", value: "text/html; charset=utf-8" },
          { name: "content-security-policy", value: look.csp },
        ],
        body: Buffer.from(look.html).toString("base64"),
      });
    if (r.resourceType === "Document" && r.frameId === targetId) {
      add(
        `It tried to leave its page for ${r.request.url.slice(0, 200)}. In the app the box would show "This box left its page."`,
      );
      return answer("Fetch.failRequest", { requestId, errorReason: "Aborted" });
    }
    answer("Fetch.continueRequest", { requestId });
  });
  // Not its load event, which a page that tried to leave while loading never gets.
  const loaded = new Promise<void>((resolve) =>
    cdp.on("Page.frameStoppedLoading", (p) => {
      if ((p as { frameId: string }).frameId === targetId) resolve();
    }),
  );
  await Promise.all([
    page("Page.enable"),
    page("Runtime.enable"),
    page("Log.enable"),
    page("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }),
    page("Emulation.setDeviceMetricsOverride", {
      width: look.width,
      height: look.height,
      deviceScaleFactor: 1,
      mobile: false,
    }),
    page("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: look.dark ? "dark" : "light" }],
    }),
  ]);
  await page("Page.navigate", { url: BOX_URL });
  await loaded;
  await Bun.sleep(SETTLE_MS);
  const { cssContentSize: size } = await page<{
    cssContentSize: { width: number; height: number };
  }>("Page.getLayoutMetrics");
  const { data } = await page<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: 0,
      y: 0,
      width: look.width,
      height: Math.max(1, Math.min(Math.ceil(size.height), MAX_LOOK_HEIGHT)),
      scale: 1,
    },
    captureBeyondViewport: true,
  });
  return { png: data, width: Math.ceil(size.width), height: Math.ceil(size.height), errors };
}

type RemoteObject = {
  type: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
};
type ExceptionDetails = { text: string; lineNumber: number; exception?: RemoteObject };
type ConsoleCall = {
  type: string;
  args: RemoteObject[];
  stackTrace?: { callFrames: { lineNumber: number }[] };
};

/** One of console.error's arguments, or what was thrown, as DevTools prints it. */
function valueText(o: RemoteObject | undefined): string {
  if (!o) return "";
  if (o.type === "string") return String(o.value);
  return (
    o.description ??
    o.unserializableValue ??
    (o.value === undefined ? o.type : JSON.stringify(o.value))
  );
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

/** The socket's routes: POST /render with { url }, POST /box with a BoxLook, and POST /check. */
export async function handle(req: Request, opts: RenderOptions = {}): Promise<Response> {
  const route = `${req.method} ${new URL(req.url).pathname}`;
  try {
    if (route === "POST /render") {
      const { url } = (await req.json().catch(() => ({}))) as { url?: unknown };
      if (typeof url !== "string" || url.length > 2000)
        return Response.json({ error: "url must be a string" }, { status: 400 });
      return Response.json(await oneAtATime(() => renderPage(url, opts)));
    }
    if (route === "POST /box") {
      const look = boxLook(await req.json().catch(() => null));
      return Response.json(await oneAtATime(() => lookAtBox(look, opts)));
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
