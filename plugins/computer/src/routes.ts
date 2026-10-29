import {
  bodyOf,
  frameRelay,
  PluginError,
  pluginRoutes,
  ScreenBusy,
  validLiveInput,
} from "@hatbot/plugin-sdk";
import { COMPUTER_PROTOCOL, type ComputerMessage } from "@hatbot/shared/computer";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import type { Computers } from "./computers";
import type { Link } from "./link";

const Rename = z.object({ name: z.string().trim().min(1, "Give it a name.").max(60) });
const Careful = z.object({ careful: z.boolean() });
const Pause = z.object({ paused: z.boolean() });

const parse = (data: unknown): ComputerMessage | null => {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as ComputerMessage;
  } catch {
    return null;
  }
};

export function routes(computers: Computers) {
  const shown = (id: string) => {
    const c = computers.get(id);
    if (!c) throw new PluginError("That's gone.", 404);
    return c;
  };
  const screen = (id: string) => {
    const s = computers.screen(id);
    if (!s) throw new PluginError("That's gone.", 404);
    return s;
  };
  return (
    pluginRoutes()
      // The Linux app's agent: only an app's device token, never a browser's session.
      .get("/computer/connect", async (c, next) => {
        if (c.env.principal?.kind !== "token")
          return c.json({ error: "Connect with the Linux app's device token." }, 403);
        await next();
      })
      .get(
        "/computer/connect",
        upgradeWebSocket((c) => {
          let link: Link | null = null;
          let forget: (() => void) | undefined;
          return {
            onOpen(_, ws) {
              // Revoking the token cuts the computer off.
              forget = c.env.onSignOut(() => ws.close(1008, "Signed out"));
            },
            onMessage(e, ws) {
              if (typeof e.data !== "string") {
                if (link && e.data instanceof ArrayBuffer) computers.frame(link, e.data);
                return;
              }
              const m = parse(e.data);
              if (!m) return;
              if (link) return computers.receive(link, m);
              if (m.t !== "hello" || typeof m.machineId !== "string" || !m.machineId)
                return ws.close(4400, "Say hello first");
              if (m.protocol !== COMPUTER_PROTOCOL)
                return ws.close(4426, "Update the Linux app, or Hatbot");
              link = computers.connect(
                m,
                c.env.principal?.id ?? 0,
                (text) => ws.send(text),
                (code, reason) => ws.close(code, reason),
              );
            },
            onClose() {
              forget?.();
              if (link) computers.disconnect(link);
            },
          };
        }),
      )
      // Frames from the computer out, your input in while you have control during a task.
      .get("/computer/live/:id", async (c, next) => {
        if (!computers.get(c.req.param("id"))) return c.json({ error: "That's gone." }, 404);
        await next();
      })
      .get(
        "/computer/live/:id",
        upgradeWebSocket((c) => {
          const id = c.req.param("id") ?? "";
          let stop: (() => void) | undefined;
          let frames: ReturnType<typeof frameRelay> | undefined;
          let forget: (() => void) | undefined;
          return {
            onOpen(_, ws) {
              forget = c.env.onSignOut(() => ws.close(1008, "Signed out"));
              const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
              frames = frameRelay(
                (frame) => ws.send(frame),
                () => raw?.getBufferedAmount?.() ?? 0,
              );
              stop = computers.watch(id, (frame) => frames?.push(frame));
            },
            onMessage(e) {
              const s = computers.screen(id);
              if (typeof e.data !== "string" || s?.control.get().control !== "owner") return;
              let m: unknown;
              try {
                m = JSON.parse(e.data);
              } catch {
                return;
              }
              if (validLiveInput(m))
                void computers
                  .linkOf(id)
                  ?.request({ op: "live_input", input: m }, 5000)
                  .catch(() => {});
            },
            onClose() {
              frames?.stop();
              stop?.();
              forget?.();
            },
          };
        }),
      )
      .get("/computers", (c) => c.json(computers.list()))
      .patch("/computers/:id", async (c) => {
        const id = c.req.param("id");
        const body = await bodyOf(c, Rename.partial().merge(Careful.partial()));
        shown(id);
        if (body.name !== undefined) computers.rename(id, body.name);
        if (body.careful !== undefined) computers.setCareful(id, body.careful);
        return c.json(shown(id));
      })
      .post("/computers/:id/pause", async (c) => {
        const id = c.req.param("id");
        await computers.pause(id, (await bodyOf(c, Pause)).paused);
        return c.json(shown(id));
      })
      .post("/computers/:id/turn-off", async (c) => {
        const id = c.req.param("id");
        await computers.turnOff(id);
        return c.json(shown(id));
      })
      .delete("/computers/:id", (c) => {
        computers.forget(c.req.param("id"));
        return c.json({ ok: true });
      })
      // Only while a task is on it: there's no remote control of an idle computer.
      .post("/computers/:id/takeover", async (c) => {
        const id = c.req.param("id");
        const s = screen(id);
        const state = s.control.get();
        if (state.activeTaskId === null && state.request === null)
          return c.json({ error: "Take over is for while a task is using it." }, 409);
        try {
          await s.control.takeover(true);
        } catch (err) {
          if (err instanceof ScreenBusy) return c.json({ error: err.message }, 409);
          throw err;
        }
        return c.json(shown(id));
      })
      .post("/computers/:id/handback", async (c) => {
        const id = c.req.param("id");
        await screen(id).control.handback();
        return c.json(shown(id));
      })
  );
}
