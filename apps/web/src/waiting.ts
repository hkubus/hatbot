// Which chat an approval or a question waits in, so each chat's tray shows only its own.
import type { Approval, Conversation, Question } from "@hatbot/shared";

type Waiting = Approval | Question;

/** One asked in a chat waits there; one from a task, in the chats of the bot asking. */
export const waitsIn = (a: Waiting, chat: Conversation) =>
  a.conversationId !== null ? a.conversationId === chat.id : chat.botIds.includes(a.botId);

/** The chat that shows it: where it was asked, or else its bot's own chat. */
export const chatOf = (a: Waiting, chats: Conversation[]) =>
  a.conversationId !== null
    ? chats.find((c) => c.id === a.conversationId)
    : chats.find((c) => c.kind === "direct" && c.botIds[0] === a.botId);

/**
 * What's waiting for you, split between the chat that's showing and the rest. `elsewhere` is the
 * one chat the rest wait in, or null when they're spread over several (or it's unknown).
 */
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
