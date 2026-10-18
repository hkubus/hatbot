import { expect, test } from "bun:test";
import type { Bot, Task } from "@hatbot/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./dom";
import { chat } from "./fixtures";

const dom = installDom();
const { From } = await import("../src/pages/Tasks");
const { loadBots } = await import("../src/store");

const bot = (id: string, name: string) => ({ id, name }) as Bot;

const task = (patch: Partial<Task>) =>
  ({ id: 9, origin: "chat", parentId: null, conversationId: null, source: null, ...patch }) as Task;

test("a task started in a chat names that chat", async () => {
  dom.answer((r) =>
    r.path === "/bots"
      ? [bot("hatbot", "Hatbot"), bot("chef", "Chef")]
      : [
          chat(1, "direct", ["hatbot"]),
          chat(2, "direct", ["chef"]),
          chat(3, "group", ["chef", "hatbot"], "Kitchen"),
        ],
  );
  await loadBots();
  const from = (patch: Partial<Task>) => renderToStaticMarkup(<From task={task(patch)} />);
  expect(from({ conversationId: 2 })).toContain(">Chat with Chef</button>");
  expect(from({ conversationId: 3 })).toContain(">Kitchen</button>");
  expect(from({ conversationId: 1 })).toContain(">Chat with Hatbot</button>");
  // A chat that's gone, or a task from before chats were kept.
  expect(from({ conversationId: 7 })).toBe("Chat");
  expect(from({ conversationId: null })).toBe("Chat");
});
