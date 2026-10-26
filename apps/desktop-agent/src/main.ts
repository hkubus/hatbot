// desktop-agent: runs on the desktop, takes orders only from the brain.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentAction,
  type AgentStatus,
  type BrowserCall,
  type BrowserInspect,
  type LiveInput,
  type SetFiles,
  type SignIn,
  uploadPage,
} from "@hatbot/shared/desktop";
import { Browser, BrowserError } from "./browser";
import { context, inspect } from "./cdp";
import { FetchError, fetchImage, fetchPage } from "./fetch";
import { browserKey, KeyError } from "./keys";
import { LiveQueue } from "./livequeue";
import { runningProfile, useProfile } from "./profile";
import { RENDER_SOCKET } from "./render";
import { MAX_BODY_BYTES, readUpTo, SHELL_SOCKET } from "./shell";
import {
  dropUploads,
  MAX_UPLOAD_BYTES,
  putUpload,
  stagedPaths,
  sweepUploads,
  UploadError,
} from "./uploads";
import {
  ActionError,
  act,
  displayUp,
  LIVE_FPS_CONTROL,
  LIVE_FPS_WATCHING,
  LiveCapture,
  screenSize,
  screenshot,
  xdotool,
  zoom,
} from "./x11";

const token = process.env.DESKTOP_AGENT_TOKEN ?? "";
if (token.length < 32) throw new Error("DESKTOP_AGENT_TOKEN is missing or too short");
const [host, port] = (process.env.HATBOT_AGENT_LISTEN ?? "127.0.0.1:7070").split(":");

/** The commit this copy was built from; the brain's updater writes it into the archive. */
const version = (() => {
  try {
    return readFileSync(join(import.meta.dir, "../VERSION"), "utf8").trim();
  } catch {
    return undefined;
  }
})();
/** Set by systemd's StateDirectory=; an archive dropped here is installed by a root service. */
const stateDir = process.env.STATE_DIRECTORY;
const MAX_UPDATE_BYTES = 10 * 1024 * 1024;
/** Endpoints added since the first deploy; the brain's checks say when the desktop is behind. */
const FEATURES = [
  "profiles",
  "exec",
  "files",
  "fetch",
  "deep-health",
  "browser-reset",
  // inspect reports the tab's address and its text boxes, for the exact-text send check.
  "fields",
  "render",
  // inspect names icon buttons and says which controls toggle or search, for the click and Enter checks.
  "gates",
  // Files staged for a task go on an add-listing page's file input.
  "upload",
  // A login Scout shares goes in a bot's profile.
  "sessions",
  "fetch-image",
];

// The display may still be starting (Xvnc restarting, say): wait for it rather than exit and be restarted.
const size = await (async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await screenSize();
    } catch (err) {
      if (attempt === 0) console.error(`waiting for the display: ${(err as Error).message}`);
      await Bun.sleep(Math.min(5000, 500 * (attempt + 1)));
    }
  }
})();
const live = new LiveCapture(size);
// Downloads land where desktop-agent can read them (it can't see /home), to be sent on to the owner.
const downloadDir = stateDir ? join(stateDir, "downloads") : null;
if (downloadDir) mkdirSync(downloadDir, { recursive: true });
const browser = new Browser(downloadDir);
const uploadDir = stateDir ? join(stateDir, "uploads") : null;
if (uploadDir) setInterval(() => sweepUploads(uploadDir), 10 * 60_000);
/** A watcher that falls this far behind skips frames instead of seeing the desktop late. */
const LIVE_BUFFER_BYTES = 256 * 1024;
/** While locked (the owner has control, or Pause all), the brain's model can't act. Live input still works. */
let locked = false;
/** What the model does on the desktop: refused while it's locked. */
const LOCKED = new Set([
  "POST /action",
  "POST /exec",
  "GET /files",
  "PUT /files",
  "POST /browser",
  // Before a task's first look at the screen: no input is going on.
  "POST /browser/profile",
  "POST /browser/reset",
  "PUT /uploads",
  "POST /browser/files",
  "POST /browser/session",
]);

const authorized = (req: Request) => {
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
const health = (): AgentStatus => ({
  ok: true,
  ...size,
  locked,
  version,
  profile: runningProfile(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  features: FEATURES,
});
/** GET /health?deep=1: plain health, plus whether the screen can be grabbed and DevTools answers. */
async function deepHealth(): Promise<AgentStatus> {
  const [x, cdp] = await Promise.all([displayUp(), browser.devToolsUp()]);
  return { ...health(), ok: x && cdp, x, cdp };
}
const image = (bytes: Uint8Array) =>
  new Response(bytes, { headers: { "content-type": "image/webp", "cache-control": "no-store" } });

async function relay(req: Request, socket: string, path: string, ms: number, what: string) {
  let res: Response;
  try {
    res = await fetch(`http://local${path}`, {
      method: req.method,
      body: req.body,
      unix: socket,
      signal: AbortSignal.timeout(ms),
    } as RequestInit);
  } catch (err) {
    if ((err as Error).name === "TimeoutError")
      return json({ error: `${what} didn't answer in time.` }, 504);
    return json({ error: `${what} isn't running (deploy.sh sets it up).` }, 503);
  }
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
  });
}

// One input at a time, in order: xdotool calls must not interleave.
let inputChain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = inputChain.then(fn);
  inputChain = p.catch(() => {});
  return p;
};

async function liveInput(m: LiveInput) {
  const xy = (x: number, y: number) => [
    String(Math.min(size.width - 1, Math.max(0, Math.round(x)))),
    String(Math.min(size.height - 1, Math.max(0, Math.round(y)))),
  ];
  switch (m.t) {
    case "move":
      return xdotool("mousemove", ...xy(m.x, m.y));
    case "button":
      return xdotool(
        "mousemove",
        ...xy(m.x, m.y),
        m.down ? "mousedown" : "mouseup",
        String(m.button),
      );
    case "wheel": {
      const steps = Math.min(10, Math.max(1, Math.round(Math.abs(m.dy || m.dx) / 50)));
      const button = m.dy ? (m.dy > 0 ? "5" : "4") : m.dx > 0 ? "7" : "6";
      return xdotool(
        "mousemove",
        ...xy(m.x, m.y),
        "click",
        "--repeat",
        String(steps),
        "--delay",
        "20",
        button,
      );
    }
    case "key": {
      const sym = browserKey(m.key);
      if (sym === null) return m.down ? xdotool("type", "--", m.key) : undefined;
      return xdotool(m.down ? "keydown" : "keyup", sym);
    }
  }
}

/** Input from the screen side may have switched tabs; the browser asks them again before its next call. */
const touched = () => browser.screenTouched();
const liveQueue = new LiveQueue((m) => serial(() => liveInput(m).finally(touched)));

const server = Bun.serve<{ off?: () => void; behind?: Uint8Array; input?: boolean }>({
  hostname: host,
  port: Number(port),
  // A render, a script or a file copy answers after minutes, not Bun's default 10 seconds.
  idleTimeout: 0,
  maxRequestBodySize: MAX_BODY_BYTES,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (!authorized(req)) return json({ error: "unauthorized" }, 401);
    const route = `${req.method} ${url.pathname}`;
    if (locked && LOCKED.has(route))
      return json({ error: "The owner has control of the desktop." }, 423);
    try {
      switch (route) {
        case "GET /health":
          return json(url.searchParams.get("deep") === "1" ? await deepHealth() : health());
        case "POST /update": {
          // A new copy of this app from the brain's updater (the Update button in Settings).
          // hatbot-desktop-agent-update.path picks it up and installs it as root, then restarts us.
          if (!stateDir) return json({ error: "updates aren't enabled; run deploy.sh once" }, 501);
          const bytes = await readUpTo(req, MAX_UPDATE_BYTES);
          if (!bytes?.length)
            return json({ error: "expected a tar archive under 10 MB" }, bytes ? 400 : 413);
          const tmp = join(stateDir, "update.tar.part");
          writeFileSync(tmp, bytes, { mode: 0o600 });
          renameSync(tmp, join(stateDir, "update.tar"));
          return json({ ok: true }, 202);
        }
        case "POST /screenshot":
          return image(await serial(() => screenshot(size)));
        case "POST /zoom": {
          const { region } = (await req.json()) as { region: number[] };
          return image(await serial(() => zoom(size, region)));
        }
        case "POST /action": {
          const { name, input } = (await req.json()) as AgentAction;
          // After it, not before: a look at the tabs in the meantime would see them as they were.
          return json(await serial(() => act(size, name, input ?? {}).finally(touched)));
        }
        case "POST /exec":
          // Not serialised with input: the shell doesn't touch the screen.
          return relay(req, SHELL_SOCKET, "/exec", 11 * 60_000, "The desktop's shell");
        case "POST /fetch":
        case "POST /fetch/image": {
          // For watchers and listings: the desktop's firewall lets it reach only the internet, so the
          // brain fetches from here instead of from the LAN. Not serialised: it doesn't touch the screen.
          const { url: target } = (await req.json()) as { url: string };
          const opts = { own: [host ?? ""] };
          try {
            return json(
              await (url.pathname === "/fetch"
                ? fetchPage(target, opts)
                : fetchImage(target, opts)),
            );
          } catch (err) {
            if (err instanceof FetchError) return json({ error: err.message }, err.status);
            throw err;
          }
        }
        case "POST /render":
        case "POST /render/box":
        case "POST /render/check":
          // For watchers that run a page's scripts, and box_look: hatbot-render, one page at a time, so
          // a render may wait behind a few others. Not serialised with input: its Chromium isn't the one
          // on screen.
          return relay(
            req,
            RENDER_SOCKET,
            url.pathname === "/render" ? "/render" : url.pathname.slice("/render".length),
            110_000,
            "The renderer",
          );
        case "GET /download": {
          const d = browser.download(url.searchParams.get("id") ?? "");
          if (!d || !(await Bun.file(d.path).exists()))
            return json({ error: "There's no finished download with that id." }, 404);
          return new Response(Bun.file(d.path), {
            headers: {
              "content-type": "application/octet-stream",
              "x-filename": encodeURIComponent(d.name),
            },
          });
        }
        case "GET /files":
        case "PUT /files":
          // Streamed through: the shell counts the bytes as they come and stops past 25 MB.
          return relay(req, SHELL_SOCKET, `/files${url.search}`, 120_000, "The desktop's shell");
        case "POST /browser": {
          const { name, input } = (await req.json()) as BrowserCall;
          return json(await serial(() => browser.call(name, input ?? {})));
        }
        case "PUT /uploads": {
          if (!uploadDir) return json({ error: "uploads aren't enabled; run deploy.sh once" }, 501);
          const bytes = await readUpTo(req, MAX_UPLOAD_BYTES);
          if (!bytes?.length)
            return json({ error: "expected a file under 15 MB" }, bytes ? 400 : 413);
          sweepUploads(uploadDir);
          const q = url.searchParams;
          await putUpload(uploadDir, q.get("stage") ?? "", q.get("name") ?? "", bytes);
          return json({ ok: true });
        }
        case "DELETE /uploads":
          if (uploadDir) dropUploads(uploadDir, url.searchParams.get("stage") ?? "");
          return json({ ok: true });
        case "POST /browser/files": {
          if (!uploadDir) return json({ error: "uploads aren't enabled; run deploy.sh once" }, 501);
          const o = (await req.json()) as SetFiles;
          const paths = stagedPaths(
            uploadDir,
            String(o.stage),
            Array.isArray(o.names) ? o.names : [],
          );
          const target = { tab_id: o.tab_id, ref: o.ref, paths };
          return json(await serial(() => browser.setFiles(target, (u) => uploadPage(u) !== null)));
        }
        case "POST /browser/profile": {
          const { id } = (await req.json()) as { id: string };
          return json({ profile: await serial(() => useProfile(id, stateDir ?? null, browser)) });
        }
        case "POST /browser/session": {
          const { profile, state } = (await req.json()) as SignIn;
          return json(
            await serial(async () => {
              // With one profile for every bot, one bot's login would be all of theirs.
              if ((await useProfile(String(profile), stateDir ?? null, browser)) !== profile)
                throw new BrowserError("This desktop has one browser profile for every bot.");
              return browser.signIn(state);
            }),
          );
        }
        case "POST /browser/reset":
          return json(await serial(() => browser.reset()));
        case "GET /browser/state":
          return json(await serial(() => browser.state()));
        case "POST /browser/inspect": {
          const at = (await req.json()) as BrowserInspect;
          return json(await serial(() => browser.inspect(at)));
        }
        case "GET /context":
          return json(
            await context(
              browser,
              url.searchParams.get("text") === "1",
              url.searchParams.get("secrets") === "1",
            ),
          );
        case "POST /inspect": {
          const { x, y } = (await req.json()) as { x?: number; y?: number };
          return json(await inspect(browser, x, y));
        }
        case "POST /lock":
          locked = true;
          live.setFps(LIVE_FPS_CONTROL);
          return json(health());
        case "POST /unlock":
          locked = false;
          // Whatever the owner's view still held down (it lost focus mid-press, say) is let go.
          liveQueue.release();
          live.setFps(LIVE_FPS_WATCHING);
          return json(health());
        case "GET /live":
          if (srv.upgrade(req, { data: {} })) return undefined;
          return json({ error: "expected a WebSocket" }, 400);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      if (
        err instanceof ActionError ||
        err instanceof BrowserError ||
        err instanceof KeyError ||
        err instanceof UploadError
      )
        return json({ error: err.message }, 400);
      console.error(route, err);
      return json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  },
  websocket: {
    // Frames out as binary JPEG; live input in as JSON text.
    open(ws) {
      ws.data.off = live.subscribe((frame) => {
        // A frame skipped here goes out once the socket drains: an unchanging screen sends no more.
        if (ws.getBufferedAmount() < LIVE_BUFFER_BYTES) {
          ws.data.behind = undefined;
          ws.sendBinary(frame);
        } else ws.data.behind = frame;
      });
    },
    drain(ws) {
      const frame = ws.data.behind;
      if (frame && ws.getBufferedAmount() < LIVE_BUFFER_BYTES) {
        ws.data.behind = undefined;
        ws.sendBinary(frame);
      }
    },
    message(ws, msg) {
      if (typeof msg !== "string") return;
      let m: LiveInput;
      try {
        m = JSON.parse(msg);
      } catch {
        return;
      }
      ws.data.input = true;
      liveQueue.push(m);
    },
    close(ws) {
      ws.data.off?.();
      // A viewer that sent input went away: nothing it pressed stays held.
      if (ws.data.input) liveQueue.release();
    },
  },
});

console.log(
  `desktop-agent on http://${server.hostname}:${server.port}, screen ${size.width}x${size.height}`,
);
