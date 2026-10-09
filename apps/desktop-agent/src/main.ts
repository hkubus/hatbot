// desktop-agent: runs on the desktop, takes orders only from the brain (PLAN.md §4.2).
import { timingSafeEqual } from "node:crypto";
import type { AgentAction, AgentStatus, LiveInput } from "@hatbot/shared/desktop";
import { context, inspect } from "./cdp";
import { browserKey } from "./keys";
import { ActionError, act, LiveCapture, screenSize, screenshot, xdotool, zoom } from "./x11";

const token = process.env.DESKTOP_AGENT_TOKEN ?? "";
if (token.length < 32) throw new Error("DESKTOP_AGENT_TOKEN is missing or too short");
const [host, port] = (process.env.HATBOT_AGENT_LISTEN ?? "127.0.0.1:7070").split(":");

const size = await screenSize();
const live = new LiveCapture(size);
/** While locked (the owner has control, or Pause all), the brain's model can't act. Live input still works. */
let locked = false;

const authorized = (req: Request) => {
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
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

const server = Bun.serve<{ off?: () => void }>({
  hostname: host,
  port: Number(port),
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (!authorized(req)) return json({ error: "unauthorized" }, 401);
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /health":
          return json({ ok: true, ...size, locked } satisfies AgentStatus);
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
        case "GET /context":
          return json(await context(url.searchParams.get("text") === "1"));
        case "POST /inspect": {
          const { x, y } = (await req.json()) as { x?: number; y?: number };
          return json(await inspect(x, y));
        }
        case "POST /lock":
          locked = true;
          return json({ ok: true, ...size, locked } satisfies AgentStatus);
        case "POST /unlock":
          locked = false;
          return json({ ok: true, ...size, locked } satisfies AgentStatus);
        case "GET /live":
          if (srv.upgrade(req, { data: {} })) return undefined;
          return json({ error: "expected a WebSocket" }, 400);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      if (err instanceof ActionError) return json({ error: err.message }, 400);
      console.error(route, err);
      return json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  },
  websocket: {
    // Frames out as binary JPEG; live input in as JSON text.
    open(ws) {
      ws.data.off = live.subscribe((frame) => ws.sendBinary(frame));
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
