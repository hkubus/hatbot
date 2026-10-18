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
// A look may also try the page (steps: clicks, typing, keys, waits, evals), and with a relay its
// hatbox.fetch reaches the box's backend through the brain: a DevTools binding, never the network.
import { chmodSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOX_KEYS,
  type BoxKey,
  type BoxLook,
  type BoxLookAnswer,
  type BoxLookError,
  type BoxLookFetch,
  type BoxLookLine,
  type BoxLookResult,
  type BoxStep,
  type BoxStepResult,
  LOOK_BINDING,
  MAX_LOOK_ERRORS,
  MAX_LOOK_HEIGHT,
  MAX_LOOK_STEPS,
  MAX_LOOK_STORE,
  MAX_LOOK_VALUE,
  type RenderResult,
} from "@hatbot/shared/desktop";
import { FetchError, readText, resolveHost, USER_AGENT, webUrl } from "./fetch";
import { DevToolsPipe } from "./pipe";

export const RENDER_SOCKET = process.env.HATBOT_RENDER_SOCKET ?? "/run/hatbot-render/render.sock";
/** Chromium is killed after this, whatever it's doing. */
const KILL_AFTER_MS = 20_000;
/** For a look that tries steps or reaches a backend, of which the steps get STEPS_MS in all. */
const KILL_TRYING_MS = 40_000;
const STEPS_MS = 25_000;
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
/** After each step, for the page's handlers to run. */
const STEP_SETTLE_MS = 150;
/** After the load, for what its page fetched then (a backend may have to start). */
const FETCH_WAIT_MS = 10_000;
const WAIT_MS = 2000;
const MAX_WAIT_MS = 5000;
const MAX_PAUSE_MS = 3000;
const EVAL_MS = 5000;
/** Requests one look's page may make of its backend. */
const MAX_LOOK_FETCHES = 50;

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
  if (b.steps !== undefined && (!Array.isArray(b.steps) || b.steps.length > MAX_LOOK_STEPS))
    throw new FetchError(`steps must be a list of up to ${MAX_LOOK_STEPS}`, 400);
  if (b.relay !== undefined && (typeof b.relay !== "string" || !/^[\w-]{16,100}$/.test(b.relay)))
    throw new FetchError("relay must be a random token", 400);
  return {
    html: b.html,
    csp: b.csp,
    width: Number(b.width),
    height: Number(b.height),
    dark: b.dark,
    ...(b.steps?.length ? { steps: b.steps.map(boxStep) } : {}),
    ...(b.relay ? { relay: b.relay } : {}),
  };
}

function boxStep(raw: unknown, i: number): BoxStep {
  const o = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max = 1000): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max;
  if (text(o.click)) return { click: o.click };
  if (text(o.type) && typeof o.text === "string" && o.text.length <= 10_000)
    return { type: o.type, text: o.text };
  if (BOX_KEYS.includes(o.press as BoxKey)) return { press: o.press as BoxKey };
  if (text(o.wait))
    return typeof o.ms === "number" && o.ms >= 0 ? { wait: o.wait, ms: o.ms } : { wait: o.wait };
  if (typeof o.wait_ms === "number" && o.wait_ms >= 0) return { wait_ms: o.wait_ms };
  if (text(o.eval, 10_000)) return { eval: o.eval };
  throw new FetchError(`step ${i + 1} isn't a step box_look knows`, 400);
}

/** A look's way out to the brain: the page's fetches go out, and each answer comes back by its id. */
type Relay = {
  send: (f: BoxLookFetch) => void;
  /** Set by the look once its page is up; false for a fetch it doesn't know. */
  answer?: (id: number, a: BoxLookAnswer["answer"]) => boolean;
};

/**
 * A box's page drawn at the screen size asked, once it has loaded and done what it does then, with the
 * errors it hit. Throws FetchError.
 */
export async function lookAtBox(
  look: BoxLook,
  opts: RenderOptions = {},
  relay?: Relay,
): Promise<BoxLookResult> {
  const dir = await mkdtemp(join(tmpdir(), "hatbot-look-"));
  // Every connection to it ends at once. Under systemd the loopback rule resets them before that.
  const proxy = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open: (s) => void s.end(), data: () => {} },
  });
  const limit =
    opts.timeoutMs ?? (look.steps?.length || look.relay ? KILL_TRYING_MS : KILL_AFTER_MS);
  // What's left for the picture once the steps are done.
  const end = Date.now() + limit - 3000;
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
    return await Promise.race([drawBox(cdp, look, end, relay), timedOut, died]);
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

async function drawBox(
  cdp: DevToolsPipe,
  look: BoxLook,
  end: number,
  relay?: Relay,
): Promise<BoxLookResult> {
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
  /** The step running, from 1, which the errors that come meanwhile are tagged with. */
  let running: number | undefined;
  const add = (message: string, line?: number) => {
    const text = cut(message, MAX_ERROR_CHARS);
    const step = running;
    const same = errors.find((e) => e.message === text && e.line === line && e.step === step);
    if (same) same.count = (same.count ?? 1) + 1;
    else if (errors.length < MAX_LOOK_ERRORS)
      errors.push({ message: text, ...(line ? { line } : {}), ...(step ? { step } : {}) });
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
  // With a relay, the preview script's hatbox.fetch calls the binding, and the brain's answer goes back
  // into the page by the page's own id. Ours are numbered here, so the page can't answer for another.
  const pending = new Map<number, (a: BoxLookAnswer["answer"]) => void>();
  if (relay) {
    let made = 0;
    cdp.on("Runtime.bindingCalled", (p) => {
      const b = p as { name: string; payload: string; executionContextId: number };
      if (b.name !== LOOK_BINDING) return;
      let f: Partial<BoxLookFetch>;
      try {
        f = JSON.parse(b.payload);
      } catch {
        return;
      }
      const own = f.id;
      if (typeof own !== "number") return;
      const reply = (a: BoxLookAnswer["answer"]) =>
        answer("Runtime.evaluate", {
          expression: `window.__hatboxAnswer(${own}, ${JSON.stringify(a)})`,
          contextId: b.executionContextId,
        });
      if (++made > MAX_LOOK_FETCHES)
        return reply({ error: `A look's page makes at most ${MAX_LOOK_FETCHES} requests.` });
      if (b.payload.length > 7_500_000)
        return reply({ error: "A request to a box carries at most 5 MB." });
      pending.set(made, reply);
      relay.send({
        id: made,
        path: String(f.path),
        ...(typeof f.method === "string" ? { method: f.method } : {}),
        ...(f.headers && typeof f.headers === "object" ? { headers: f.headers } : {}),
        ...(typeof f.body === "string" ? { body: f.body } : {}),
        ...(f.base64 === true ? { base64: true } : {}),
      });
    });
    relay.answer = (id, a) => {
      const reply = pending.get(id);
      pending.delete(id);
      reply?.(a);
      return Boolean(reply);
    };
  }
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
    ...(relay ? [page("Runtime.addBinding", { name: LOOK_BINDING })] : []),
  ]);
  /** A short wait, then on until the page's fetches have their answers (by `until`). */
  const settle = async (ms: number, until: number) => {
    await Bun.sleep(ms);
    while (pending.size && Date.now() < until) await Bun.sleep(50);
  };
  await page("Page.navigate", { url: BOX_URL });
  await loaded;
  await settle(SETTLE_MS, Math.min(Date.now() + FETCH_WAIT_MS, end));

  const tried = look.steps
    ? await runSteps(page, look.steps, end, settle, (n) => (running = n))
    : [];
  const trying = Boolean(look.steps || relay);
  const store = trying ? await savedStore(page) : null;
  // A step may have scrolled; the picture is of the top of the page.
  if (look.steps) await inPage(page, "() => scrollTo(0, 0)").catch(() => {});
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
  return {
    png: data,
    width: Math.ceil(size.width),
    height: Math.ceil(size.height),
    errors,
    ...(look.steps ? { steps: tried } : {}),
    ...(store !== null ? { store } : {}),
  };
}

type Page = <T>(method: string, params?: object) => Promise<T>;

/** `text` cut at `max` characters, marked. */
const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Rejects once `ms` have gone by. */
function within<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: Timer | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(why)), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

/** `fn`'s source called in the page with `args`, its value back (awaited). Throws what it threw. */
async function inPage<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  const r = await page<{ result: RemoteObject; exceptionDetails?: ExceptionDetails }>(
    "Runtime.evaluate",
    {
      expression: `(${fn})(${args.map((a) => JSON.stringify(a)).join(", ")})`,
      awaitPromise: true,
      returnByValue: true,
    },
  );
  if (r.exceptionDetails) throw new Error(thrownText(r.exceptionDetails));
  return r.result.value as T;
}

const thrownText = (d: ExceptionDetails) =>
  d.exception?.description?.split("\n")[0] ?? (valueText(d.exception) || d.text);

/**
 * The steps in order, each followed by a short settle; the first that fails, or the steps' time
 * running out, ends the run. `now(n)`: the step running, for the errors that come meanwhile.
 */
async function runSteps(
  page: Page,
  steps: BoxStep[],
  end: number,
  settle: (ms: number, until: number) => Promise<void>,
  now: (n: number) => void,
): Promise<BoxStepResult[]> {
  const until = Math.min(Date.now() + STEPS_MS, end);
  const out: BoxStepResult[] = [];
  for (const [i, step] of steps.entries()) {
    now(i + 1);
    const left = until - Date.now();
    const late = `Out of time: the steps have ${STEPS_MS / 1000} seconds in all.`;
    try {
      if (left <= 0) throw new Error(late);
      const value = await within(tryStep(page, step, left), left, late);
      out.push(value === undefined ? { ok: true } : { ok: true, value });
    } catch (err) {
      out.push({ ok: false, error: cut((err as Error).message, MAX_ERROR_CHARS) });
      break;
    }
    await settle(STEP_SETTLE_MS, until);
  }
  return out;
}

/** DOM key names to what Chromium's input expects (as browser.ts has them). */
const KEYS: Record<BoxKey, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

async function press(page: Page, name: BoxKey) {
  const def = KEYS[name];
  if (!def) throw new Error(`${name} isn't a key a step presses.`);
  const { text, keyCode, ...key } = def;
  await page("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    ...key,
    windowsVirtualKeyCode: keyCode,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await page("Input.dispatchKeyEvent", { type: "keyUp", ...key, windowsVirtualKeyCode: keyCode });
}

/** The element in view, its middle, and what's on top of it there when that's something else. */
const FIND_TO_CLICK = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { hidden: true };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).join(".") : "");
  return { x, y, over: top && !el.contains(top) && !top.contains(el) ? name(top) : null };
}`;

/** Focuses the element and selects what's in it, so typing replaces it: how it can be typed in. */
const FOCUS_TO_TYPE = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return "none";
  el.scrollIntoView({ block: "center" });
  if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !/^(text|search|email|url|tel|password|number)$/.test(el.type))) return "set";
  el.focus();
  if (document.activeElement !== el) return "no";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
  else if (el.isContentEditable) getSelection().selectAllChildren(el);
  else return "no";
  return "type";
}`;

/** For a date, a colour, a range or a select, which aren't typed into: the value set as a pick would. */
const SET_VALUE = `(sel, text) => {
  const el = document.querySelector(sel);
  el.focus();
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (set) set.call(el, text); else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
}`;

const CHANGED = `(sel) => {
  const el = document.querySelector(sel);
  if (el && !el.isContentEditable) el.dispatchEvent(new Event("change", { bubbles: true }));
}`;

/** One step: what it gives back (an eval's value, a note on a click), or it throws why it failed. */
async function tryStep(page: Page, step: BoxStep, left: number): Promise<string | undefined> {
  const none = (sel: string) => new Error(`Nothing matches ${sel}.`);
  if ("click" in step) {
    const at = await inPage<{ x: number; y: number; over: string | null; hidden?: true } | null>(
      page,
      FIND_TO_CLICK,
      step.click,
    );
    if (!at) throw none(step.click);
    if (at.hidden) throw new Error(`${step.click} matches an element that isn't shown.`);
    const mouse = { x: at.x, y: at.y, button: "left" as const };
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await page("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...mouse,
      buttons: 1,
      clickCount: 1,
    });
    await page("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...mouse,
      buttons: 0,
      clickCount: 1,
    });
    return at.over ? `It landed on ${at.over}, which covers it.` : undefined;
  }
  if ("type" in step) {
    const how = await inPage<string>(page, FOCUS_TO_TYPE, step.type);
    if (how === "none") throw none(step.type);
    if (how === "no") throw new Error(`${step.type} can't be typed in.`);
    if (how === "set") {
      const value = await inPage<string>(page, SET_VALUE, step.type, step.text);
      if (value !== step.text)
        throw new Error(`${step.type} didn't take ${JSON.stringify(cut(step.text, 60))}.`);
      return undefined;
    }
    // A key's own press empties it, as a person would; text goes in as one input.
    if (step.text) await page("Input.insertText", { text: step.text });
    else await press(page, "Backspace");
    await inPage(page, CHANGED, step.type);
    return undefined;
  }
  if ("press" in step) {
    await press(page, step.press);
    return undefined;
  }
  if ("wait" in step) {
    const ms = Math.min(step.ms ?? WAIT_MS, MAX_WAIT_MS);
    const until = Date.now() + Math.min(ms, left);
    for (;;) {
      if (await inPage<boolean>(page, "(sel) => Boolean(document.querySelector(sel))", step.wait))
        return undefined;
      if (Date.now() >= until) throw new Error(`Nothing matched ${step.wait} in ${ms / 1000} s.`);
      await Bun.sleep(100);
    }
  }
  if ("wait_ms" in step) {
    await Bun.sleep(Math.min(step.wait_ms, MAX_PAUSE_MS, left));
    return undefined;
  }
  const ms = Math.min(EVAL_MS, left);
  const r = await within(
    page<{ result: RemoteObject; exceptionDetails?: ExceptionDetails }>("Runtime.evaluate", {
      expression: step.eval,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      // Stops a loop that never ends, which would hold the picture back.
      timeout: Math.max(1, ms),
    }),
    ms,
    `It didn't finish in ${EVAL_MS / 1000} s.`,
  );
  if (r.exceptionDetails) throw new Error(thrownText(r.exceptionDetails));
  const v =
    r.result.unserializableValue ??
    (r.result.value === undefined ? undefined : JSON.stringify(r.result.value));
  return v === undefined ? undefined : cut(v, MAX_LOOK_VALUE);
}

/** What the page saved by the end, read through its own hatbox.store, as JSON; null if it can't be read. */
async function savedStore(page: Page): Promise<string | null> {
  const read = `async () => {
    const s = window.hatbox && window.hatbox.store;
    if (!s) return null;
    const o = {};
    for (const k of await s.keys()) o[k] = await s.get(k);
    return JSON.stringify(o);
  }`;
  try {
    const json = await within(inPage<string | null>(page, read), 2000, "slow");
    return typeof json === "string" ? cut(json, MAX_LOOK_STORE) : null;
  } catch {
    return null;
  }
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

/** Looks with a relay, by their token, while they're queued or running. */
const relays = new Map<string, Relay>();

/**
 * A look whose page reaches its backend: the answer is NDJSON, each of the page's fetches a line as it
 * comes and then the result, while the brain answers the fetches on POST /box/answer.
 */
function relayed(look: BoxLook, opts: RenderOptions): Response {
  const token = look.relay as string;
  if (relays.has(token))
    return Response.json({ error: "That look is already running." }, { status: 409 });
  const relay: Relay = { send: () => {} };
  relays.set(token, relay);
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const line = (l: BoxLookLine) => {
        if (!open) return;
        try {
          c.enqueue(encoder.encode(`${JSON.stringify(l)}\n`));
        } catch {
          open = false;
        }
      };
      relay.send = (fetch) => line({ fetch });
      oneAtATime(() => lookAtBox(look, opts, relay))
        .then(
          (result) => line({ result }),
          (err) =>
            line(
              err instanceof FetchError
                ? { error: err.message, status: err.status }
                : { error: (err as Error).message, status: 500 },
            ),
        )
        .finally(() => {
          relays.delete(token);
          if (open) c.close();
          open = false;
        });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

/**
 * The socket's routes: POST /render with { url }, POST /box with a BoxLook (and POST /box/answer for a
 * look's fetches), and POST /check.
 */
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
      if (look.relay) return relayed(look, opts);
      return Response.json(await oneAtATime(() => lookAtBox(look, opts)));
    }
    if (route === "POST /box/answer") {
      const a = (await req.json().catch(() => ({}))) as Partial<BoxLookAnswer>;
      const answered =
        typeof a.look === "string" &&
        typeof a.id === "number" &&
        a.answer !== null &&
        typeof a.answer === "object" &&
        relays.get(a.look)?.answer?.(a.id, a.answer);
      return answered
        ? Response.json({ ok: true })
        : Response.json({ error: "No look is waiting for that." }, { status: 404 });
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
