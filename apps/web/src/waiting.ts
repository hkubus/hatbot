import type { Approval, Conversation, Question } from "@hatbot/shared";

type Waiting = Approval | Question;

/** One asked in a chat waits there; one from a task, in the bot's chats but not its threads. */
export const waitsIn = (a: Waiting, chat: Conversation) =>
  a.conversationId !== null
    ? a.conversationId === chat.id
    : chat.kind !== "thread" && chat.botIds.includes(a.botId);

export const needsYouIn = (thread: Conversation, waiting: Waiting[]) =>
  thread.needsYou || waiting.some((a) => a.status === "pending" && waitsIn(a, thread));

export const chatOf = (a: Waiting, chats: Conversation[]) =>
  a.conversationId !== null
    ? chats.find((c) => c.id === a.conversationId)
    : chats.find((c) => c.kind === "direct" && c.botIds[0] === a.botId);

export function splitWaiting<T extends Waiting>(
  pending: T[],
  chat: Conversation | undefined,
  chats: Conversation[],
) {
  const here = chat ? pending.filter((a) => waitsIn(a, chat)) : [];
  const rest = pending.filter((a) => !here.includes(a));
  const homes = new Set(rest.map((a) => chatOf(a, chats)));
  const only = homes.size === 1 ? [...homes][0] : undefined;
  return { here, rest: rest.length, elsewhere: only ?? null };
}
