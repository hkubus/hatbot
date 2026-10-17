import { expect, test } from "bun:test";
import { installDom } from "./dom";

installDom();
const { kindIn, lapsedIn, modeIn, withKind, withMode } = await import("../src/plugins/mcp");

type Server = Parameters<typeof modeIn>[0];
type Tool = Parameters<typeof modeIn>[1];
const server = (patch: Partial<Server> = {}): Server => ({
  name: "shop",
  transport: "http",
  headers: {},
  args: [],
  env: {},
  trusted: false,
  enabled: true,
  tools: {},
  accepted: {},
  pinned: {},
  kinds: {},
  ...patch,
});
const tool = (patch: Partial<Tool> = {}): Tool => ({
  name: "search",
  description: "Search listings",
  schema: "{}",
  mode: "ask",
  problem: null,
  hash: "h1",
  guess: null,
  ...patch,
});

test("the mode shown is the one that applies: a money tool never asks first or chats", () => {
  const order = tool({ name: "place_order", guess: "purchase" });
  expect(modeIn(server(), order)).toBe("always");
  expect(modeIn(server({ tools: { place_order: "ask" } }), order)).toBe("always");
  expect(
    modeIn(server({ tools: { place_order: "chat" }, pinned: { place_order: "h1" } }), order),
  ).toBe("allow");
  // The owner says it doesn't move money: then it asks first like any other.
  expect(kindIn(server({ kinds: { place_order: "none" } }), order)).toBe("none");
  expect(modeIn(server({ kinds: { place_order: "none" } }), order)).toBe("ask");
});

test("Chat or Allow is kept for the definition it was chosen for", () => {
  const t = tool();
  const chosen = { ...server(), ...withMode(server(), t, "chat") };
  expect(chosen.pinned).toEqual({ search: "h1" });
  expect(modeIn(chosen, t)).toBe("chat");
  const changed = tool({ hash: "h2" });
  expect(lapsedIn(chosen, changed)).toBe(true);
  expect(modeIn(chosen, changed)).toBe("ask");
  // Choosing again pins the new one; another mode drops the pin.
  expect(withMode(chosen, changed, "chat").pinned).toEqual({ search: "h2" });
  expect(withMode(chosen, changed, "always").pinned).toEqual({});
});

test("a kind is stored only when it differs from the guess", () => {
  const order = tool({ name: "place_order", guess: "purchase" });
  expect(withKind(server(), order, "purchase").kinds).toEqual({});
  expect(withKind(server(), order, "none").kinds).toEqual({ place_order: "none" });
  expect(withKind(server(), tool(), "account_security").kinds).toEqual({
    search: "account_security",
  });
});
