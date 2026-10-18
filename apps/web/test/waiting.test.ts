import { expect, test } from "bun:test";
import type { Approval } from "@hatbot/shared";
import { splitWaiting } from "../src/waiting";
import { chat } from "./fixtures";

const approval = (id: number, botId: string, conversationId: number | null = null) =>
  ({
    id,
    botId,
    conversationId,
    taskId: conversationId ? null : id,
    status: "pending",
  }) as Approval;

const hatbot = chat(1, "direct", ["hatbot"]);
const haggler = chat(2, "direct", ["haggler"]);
const coder = chat(3, "direct", ["coder"]);
const group = chat(4, "group", ["coder", "hatbot"]);
const chats = [hatbot, haggler, coder, group];

test("a chat shows only its own approvals, with one line for the rest", () => {
  const mandate = approval(1, "haggler", 2);
  const payment = approval(2, "haggler");
  const deploy = approval(3, "coder");
  const inGroup = approval(4, "hatbot", 4);
  const pending = [mandate, payment, deploy, inGroup];

  // The Haggler's mandate and payment wait in its chat, not in the Coder's or the group's.
  expect(splitWaiting(pending, haggler, chats)).toEqual({
    here: [mandate, payment],
    rest: 2,
    elsewhere: null,
  });
  expect(splitWaiting(pending, coder, chats)).toEqual({ here: [deploy], rest: 3, elsewhere: null });
  // A group shows what was asked in it, and its bots' tasks.
  expect(splitWaiting(pending, group, chats).here).toEqual([deploy, inGroup]);
  // Asked in the group: not in Hatbot's own chat, though Hatbot asked.
  expect(splitWaiting([inGroup], hatbot, chats)).toEqual({ here: [], rest: 1, elsewhere: group });
  // All the rest in one chat: the line names it.
  expect(splitWaiting([mandate, payment, deploy], coder, chats)).toEqual({
    here: [deploy],
    rest: 2,
    elsewhere: haggler,
  });
  // Before the chats have loaded, nothing is shown as this chat's.
  expect(splitWaiting(pending, undefined, [])).toEqual({ here: [], rest: 4, elsewhere: null });
});
