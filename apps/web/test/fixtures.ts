import type { Conversation, ThreadMessage } from "@hatbot/shared";

export const msg = (id: number, patch: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id,
  role: "assistant",
  conversationId: 1,
  botId: "hatbot",
  kind: "text",
  text: `Message ${id}`,
  status: "done",
  createdAt: "2026-10-17T10:00:00.000Z",
  taskId: null,
  scheduleId: null,
  negotiationId: null,
  episodeId: null,
  editedAt: null,
  seenAt: "2026-10-17T10:00:00.000Z",
  ...patch,
});

export const chat = (
  id: number,
  kind: Conversation["kind"],
  botIds: string[],
  title: string | null = null,
) => ({ id, kind, title, botIds, unread: 0, lastMessageAt: null }) as Conversation;
