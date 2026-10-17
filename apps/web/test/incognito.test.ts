import { expect, test } from "bun:test";
import { installDom } from "./dom";

const dom = installDom();
// This tab was incognito in chat 5 when it was reloaded.
dom.storage.setItem("hatbot:incognito", "5");
dom.answer(() => []);
// Its own copy of the store, which reads the tab's storage as it loads.
const store = await import("../src/store.ts?incognito");

test("a reloaded incognito chat stays incognito, and only that chat", async () => {
  expect(store.getState()).toMatchObject({ conversationId: 5, incognito: true });
  await store.openConversation(5);
  expect(store.getState()).toMatchObject({ conversationId: 5, incognito: true });
  await store.loadThread();
  expect(dom.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    "GET /conversations/5/messages?limit=50&incognito=1",
  ]);

  // Going to another chat leaves it, which deletes its conversation.
  await store.openConversation(1);
  expect(store.getState()).toMatchObject({ conversationId: 1, incognito: false });
  expect(dom.requests.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/conversations/5/incognito",
  });
  expect(dom.storage.getItem("hatbot:incognito")).toBeNull();

  // Incognito in Hatbot's chat: the tab remembers which chat.
  await store.setIncognito(true);
  expect(dom.storage.getItem("hatbot:incognito")).toBe("1");
  await store.setIncognito(false);
  expect(dom.storage.getItem("hatbot:incognito")).toBeNull();
  expect(dom.requests.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/conversations/1/incognito",
  });
});
