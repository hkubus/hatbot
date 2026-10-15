// desktop-agent: runs on the desktop, takes orders only from the brain (PLAN.md §4.2).
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentAction,
  AgentStatus,
  BrowserCall,
  BrowserInspect,
  LiveInput,
} from "@hatbot/shared/desktop";
import { Browser, BrowserError } from "./browser";
import { context, inspect } from "./cdp";
import { FetchError, fetchPage } from "./fetch";
import { browserKey } from "./keys";
import { runningProfile, useProfile } from "./profile";
import { SHELL_SOCKET } from "./shell";
import {
  ActionError,
  act,
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
const FEATURES = ["profiles", "exec", "files", "fetch"];

const size = await screenSize();
const live = new LiveCapture(size);
// Downloads land where desktop-agent can read them (it can't see /home), to be sent on to the owner.
const downloadDir = stateDir ? join(stateDir, "downloads") : null;
if (downloadDir) mkdirSync(downloadDir, { recursive: true });
const browser = new Browser(downloadDir);
/** A watcher that falls this far behind skips frames instead of seeing the desktop late. */
const LIVE_BUFFER_BYTES = 256 * 1024;
/** While locked (the owner has control, or Pause all), the brain's model can't act. Live input still works. */
let locked = false;

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
const image = (bytes: Uint8Array) =>
  new Response(bytes, { headers: { "content-type": "image/webp", "cache-control": "no-store" } });

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

const server = Bun.serve<{ off?: () => void; behind?: Uint8Array }>({
  hostname: host,
  port: Number(port),
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (!authorized(req)) return json({ error: "unauthorized" }, 401);
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /health":
          return json(health());
        case "POST /update": {
          // A new copy of this app from the brain's updater (the Update button in Settings).
          // hatbot-desktop-agent-update.path picks it up and installs it as root, then restarts us.
          if (!stateDir) return json({ error: "updates aren't enabled; run deploy.sh once" }, 501);
          const bytes = new Uint8Array(await req.arrayBuffer());
          if (!bytes.length || bytes.length > MAX_UPDATE_BYTES)
            return json({ error: "expected a tar archive under 10 MB" }, 400);
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
          if (locked) return json({ error: "The owner has control of the desktop." }, 423);
          const { name, input } = (await req.json()) as AgentAction;
          return json(await serial(() => act(size, name, input ?? {})));
        }
        case "POST /exec": {
          // Not serialised with input: the shell doesn't touch the screen.
          if (locked) return json({ error: "The owner has control of the desktop." }, 423);
          let res: Response;
          try {
            res = await fetch("http://shell/exec", {
              method: "POST",
              unix: SHELL_SOCKET,
              headers: { "content-type": "application/json" },
              body: await req.text(),
              signal: AbortSignal.timeout(11 * 60_000),
            } as RequestInit);
          } catch {
            return json(
              { error: "The desktop's shell isn't running (deploy.sh sets it up)." },
              503,
            );
          }
          return new Response(res.body, {
            status: res.status,
            headers: { "content-type": "application/json" },
          });
        }
        case "POST /fetch": {
          // For watchers: the desktop's firewall lets it reach only the internet, so the brain fetches
          // pages from here instead of from the LAN. Not serialised: it doesn't touch the screen.
          const { url: target } = (await req.json()) as { url: string };
          if (!/^https?:\/\//.test(target ?? ""))
            return json({ error: "Only http and https." }, 400);
          try {
            return json(await fetchPage(target, { own: [host ?? ""] }));
          } catch (err) {
            if (err instanceof FetchError) return json({ error: err.message }, err.status);
            throw err;
          }
        }
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
        case "PUT /files": {
          if (locked) return json({ error: "The owner has control of the desktop." }, 423);
          let res: Response;
          try {
            res = await fetch(`http://shell/files${url.search}`, {
              method: req.method,
              unix: SHELL_SOCKET,
              body: req.method === "PUT" ? await req.arrayBuffer() : undefined,
              signal: AbortSignal.timeout(120_000),
            } as RequestInit);
          } catch {
            return json(
              { error: "The desktop's shell isn't running (deploy.sh sets it up)." },
              503,
            );
          }
          return new Response(res.body, {
            status: res.status,
            headers: {
              "content-type": res.headers.get("content-type") ?? "application/octet-stream",
            },
          });
        }
        case "POST /browser": {
          if (locked) return json({ error: "The owner has control of the desktop." }, 423);
          const { name, input } = (await req.json()) as BrowserCall;
          return json(await serial(() => browser.call(name, input ?? {})));
        }
        case "POST /browser/profile": {
          // Before a task's first look at the screen: no input is going on.
          if (locked) return json({ error: "The owner has control of the desktop." }, 423);
          const { id } = (await req.json()) as { id: string };
          return json({ profile: await serial(() => useProfile(id, stateDir ?? null, browser)) });
        }
        case "GET /browser/state":
          return json(await serial(() => browser.state()));
        case "POST /browser/inspect": {
          const at = (await req.json()) as BrowserInspect;
          return json(await serial(() => browser.inspect(at)));
        }
        case "GET /context":
          return json(await context(url.searchParams.get("text") === "1"));
        case "POST /inspect": {
          const { x, y } = (await req.json()) as { x?: number; y?: number };
          return json(await inspect(x, y));
        }
        case "POST /lock":
          locked = true;
          live.setFps(LIVE_FPS_CONTROL);
          return json(health());
        case "POST /unlock":
          locked = false;
          live.setFps(LIVE_FPS_WATCHING);
          return json(health());
        case "GET /live":
          if (srv.upgrade(req, { data: {} })) return undefined;
          return json({ error: "expected a WebSocket" }, 400);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      if (err instanceof ActionError || err instanceof BrowserError)
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
    message(_ws, msg) {
      if (typeof msg !== "string") return;
      let m: LiveInput;
      try {
        m = JSON.parse(msg);
      } catch {
        return;
      }
      void serial(() => liveInput(m)).catch((err) => console.error("live input", err));
    },
    close(ws) {
      ws.data.off?.();
    },
  },
});

console.log(
  `desktop-agent on http://${server.hostname}:${server.port}, screen ${size.width}x${size.height}`,
);
