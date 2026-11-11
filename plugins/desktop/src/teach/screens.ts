// What Teach needs from a screen, the desktop's or one of your computers': your input from Live while you
// have control, whether the field with the keyboard takes a secret, screenshots only when no secret can
// show, and what's on screen.

import { BLOCKED_TEXT, type ComputerScreen } from "@hatbot/plugin-computer";
import type { Live, ScreenLane, ScreenState } from "@hatbot/plugin-sdk";
import type { ComputerField } from "@hatbot/shared/computer";
import { hintWords, SECRET_HINT } from "@hatbot/shared/desktop";
import type { DesktopService } from "../index";
import { type FieldCheck, OffPage } from "./recorder";

/** Holds a screen's lane while you record, so no task starts on it. */
export const TEACH_LANE = -2;

export type TeachScreen = {
  /** A computer's id; null for the desktop. */
  id: string | null;
  /** "the desktop", or the computer's name. */
  name: string;
  lane: ScreenLane;
  control: { get(): ScreenState };
  live: Live;
  /** Why it can't be recorded on now, as a sentence; null when it can. */
  unavailable(): string | null;
  /** Gives you control, and back to Hatbot after. */
  takeover(): Promise<void>;
  handback(): Promise<void>;
  /** The field with the keyboard; OffPage when it's somewhere nothing can check. */
  field(): Promise<FieldCheck>;
  /** The screen now and the address on it, or null when it may show a secret. */
  shot(): Promise<{ bytes: Uint8Array; url?: string | null } | null>;
  /** The page on screen; on a computer, the window with the keyboard too. */
  page(): Promise<{ url: string | null; title: string | null; app?: string }>;
};

export function desktopScreen(desk: Omit<DesktopService, "teach">): TeachScreen {
  const { agent, control } = desk;
  return {
    id: null,
    name: "the desktop",
    lane: desk.lane,
    control,
    live: desk.live,
    unavailable: () =>
      agent.configured && control.get().online ? null : "The desktop isn't answering.",
    takeover: () => control.takeover(),
    handback: () => control.handback(),
    field: async () => {
      const el = await agent.inspect();
      // No page on screen, or the keyboard is elsewhere (the address bar, another window): the typing
      // went somewhere CDP can't see.
      if (!el || el.pageFocus === false) throw new OffPage("the keyboard isn't on a page");
      return {
        secret:
          Boolean(el.secret) || el.type === "password" || el.tag === "iframe" || el.tag === "frame",
        url: el.url ?? null,
      };
    },
    shot: async () => {
      const [bytes, page] = await Promise.all([
        agent.screenshot(),
        // A page that can't say whether it shows a secret may show one. An older desktop-agent that
        // doesn't say at all is taken at its word.
        agent.context(false, true).catch(() => null),
      ]);
      return page && !page.secretShown ? { bytes, url: page.url } : null;
    },
    page: () => agent.context(),
  };
}

/**
 * A computer's field takes a secret: the app says it's a password field, it's in a page's frame (a payment
 * form's card fields are), it's a terminal (a sudo or ssh prompt marks nothing), or its names say so, as on
 * the desktop. Closed shadow roots, which the desktop can't see into, are in the accessibility tree.
 */
export const secretField = (f: ComputerField) =>
  f.password || f.inFrame || f.role === "terminal" || SECRET_HINT.test(hintWords(f.names));

export function computerScreen(c: ComputerScreen): TeachScreen {
  return {
    id: c.id,
    get name() {
      return c.name;
    },
    lane: c.lane,
    control: c.control,
    live: c.live,
    unavailable: () => {
      const blocked = c.blocked();
      // Someone at the computer meanwhile is fine: what you do from Live is what's recorded.
      if (blocked && blocked !== "owner") return `${c.name} ${BLOCKED_TEXT[blocked]}.`;
      if (!["teach", "live"].every((f) => c.features().includes(f)))
        return `Update Hatbot's desktop app on ${c.name} to teach on it.`;
      return null;
    },
    // The monitor stays the one it was when you started, so Live's points mean the same throughout.
    takeover: async () => {
      await c.claim(TEACH_LANE);
      try {
        await c.control.takeover();
      } catch (err) {
        await c.release(TEACH_LANE);
        throw err;
      }
    },
    handback: async () => {
      await c.control.handback();
      await c.release(TEACH_LANE);
    },
    field: async () => {
      const { field, url } = await c.focus({ field: true });
      // An app with no accessibility tree, or nothing in it with the keyboard.
      if (!field) throw new OffPage("nothing says what has the keyboard");
      return { secret: secretField(field), url };
    },
    shot: async () => {
      const [bytes, focus] = await Promise.all([
        c.agent().screenshot(),
        c.focus({ filled: true }).catch(() => null),
      ]);
      if (!focus?.filled || focus.filled.some(secretField)) return null;
      return { bytes, url: focus.url };
    },
    page: async () => {
      const { window, url } = await c.focus({});
      return { url, title: window?.title ?? null, ...(window ? { app: window.appId } : {}) };
    },
  };
}
