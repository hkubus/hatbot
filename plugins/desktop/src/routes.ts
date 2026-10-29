import { frameRelay, pluginRoutes, validLiveInput } from "@hatbot/plugin-sdk";
import type { LiveInput } from "@hatbot/shared/desktop";
import { upgradeWebSocket } from "hono/bun";
import type { DesktopAgent } from "./client";
import { type Desktop, DesktopBusy } from "./control";

export { frameRelay } from "@hatbot/plugin-sdk";

/** What the owner does in the live view while they have control, as it's sent: Teach records it. */
export class Live {
  private inputs = new Set<(m: LiveInput) => void>();
  private gone = new Set<() => void>();

  onInput(fn: (m: LiveInput) => void): () => void {
    this.inputs.add(fn);
    return () => this.inputs.delete(fn);
  }

  /** A live view that sent input closed: desktop-agent let go of the keys it held. */
  onViewerGone(fn: () => void): () => void {
    this.gone.add(fn);
    return () => this.gone.delete(fn);
  }

  input(m: LiveInput) {
    for (const fn of this.inputs) fn(m);
  }

  viewerGone() {
    for (const fn of this.gone) fn();
  }
}

export function routes(agent: DesktopAgent, desktop: Desktop, live: Live) {
  return (
    pluginRoutes()
      .get("/desktop/live", async (c, next) => {
        if (!agent.configured) return c.json({ error: "The desktop isn't set up." }, 503);
        await next();
      })
      // JPEG frames from desktop-agent out, your input in while you have control.
      .get(
        "/desktop/live",
        upgradeWebSocket((c) => {
          let upstream: WebSocket | null = null;
          let frames: ReturnType<typeof frameRelay> | undefined;
          let forget: (() => void) | undefined;
          let sent = false;
          return {
            onOpen(_, ws) {
              // Signing out or revoking the token ends the live view too.
              forget = c.env.onSignOut(() => ws.close(1008, "Signed out"));
              const { url, headers } = agent.liveSocket();
              const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
              frames = frameRelay(
                (frame) => ws.send(frame),
                () => raw?.getBufferedAmount?.() ?? 0,
              );
              upstream = new WebSocket(url, { headers } as unknown as string[]);
              upstream.binaryType = "arraybuffer";
              upstream.onmessage = (e) => frames?.push(e.data as ArrayBuffer);
              upstream.onclose = () => ws.close(1011, "desktop disconnected");
              upstream.onerror = () => ws.close(1011, "desktop unreachable");
            },
            onMessage(e) {
              if (typeof e.data !== "string" || desktop.get().control !== "owner") return;
              let m: unknown;
              try {
                m = JSON.parse(e.data);
              } catch {
                return;
              }
              if (validLiveInput(m) && upstream?.readyState === WebSocket.OPEN) {
                upstream.send(JSON.stringify(m));
                live.input(m);
                sent = true;
              }
            },
            onClose() {
              frames?.stop();
              upstream?.close();
              forget?.();
              if (sent) live.viewerGone();
            },
          };
        }),
      )
      .get("/desktop/status", (c) => c.json(desktop.get()))
      .post("/desktop/takeover", async (c) => {
        try {
          await desktop.takeover(true);
        } catch (err) {
          if (err instanceof DesktopBusy) return c.json({ error: err.message }, 409);
          return c.json({ error: "The desktop isn't answering." }, 503);
        }
        return c.json(desktop.get());
      })
      .post("/desktop/handback", async (c) => {
        try {
          await desktop.handback();
        } catch {
          return c.json({ error: "The desktop isn't answering." }, 503);
        }
        return c.json(desktop.get());
      })
  );
}
