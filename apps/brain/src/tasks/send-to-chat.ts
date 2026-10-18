// send_to_chat: a task hands the bot in the chat a file, like a JSON series to draw as a chart. It's
// stored on the task that reports to the chat, and only that bot reads it, with the task's result.
import { CHART_FILE_MAX_ROWS } from "@hatbot/shared";
import { z } from "zod";
import { sizeText } from "../attachments";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import type { Tasks } from "./service";

/** Files one task may hand the chat. */
const MAX_CHAT_FILES = 5;

const fields = {
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The file's name, with its type: \"cpu-week.json\". The file's own if unset"),
  content: z
    .string()
    .min(1)
    .max(400_000)
    .optional()
    .describe("The file's text, written out: JSON, CSV or the like"),
};
const needsName = (v: { content?: string; name?: string }) => !v.content || !!v.name;
const NAME_ERROR = "A file written out with content needs a name.";

export const SendToChat = z
  .object({
    ...fields,
    path: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Or a file in the desktop's sandbox, relative to its home as code_run sees it"),
  })
  .refine((v) => !v.content !== !v.path, "Give either content or path.")
  .refine(needsName, NAME_ERROR);

export const DesktopSendToChat = z
  .object({
    ...fields,
    path: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Or a file desktop_shell made, relative to its home"),
    download_id: z.string().max(100).optional().describe("Or a finished browser download's id"),
  })
  .refine(
    (v) => [v.content, v.path, v.download_id].filter(Boolean).length === 1,
    "Give one of content, path or download_id.",
  )
  .refine(needsName, NAME_ERROR);

export const SEND_TO_CHAT_DESCRIPTION = `Hand the bot in the chat a file to use when it's told how this task ended: data for it to show the owner, like a JSON series to draw as a chart, or a CSV table. The owner doesn't get it as a file; send_file is for that. It can chart up to ${CHART_FILE_MAX_ROWS.toLocaleString("en-US")} rows from a CSV or JSON file, so there's no need to thin a series. Text up to 400 KB and images are read whole; the bot reaches bigger files through its sandbox.`;

/**
 * Stores the file for the chat on the task that reports there: this one, or the task that started it.
 * Returns what to tell the model, and whether that's an error.
 */
export async function sendToChat(
  tasks: Tasks,
  taskId: number,
  input: { name?: string; content?: string; path?: string; download_id?: string },
  desktop: DesktopAgent | undefined,
): Promise<{ text: string; isError?: boolean }> {
  const { attachments } = tasks.d;
  if (!attachments) return { text: "Files can't be handed to the chat here.", isError: true };
  let target = tasks.get(taskId);
  while (target?.parentId) target = tasks.get(target.parentId);
  if (!target) return { text: "The task is gone.", isError: true };
  const handed = attachments.ofTasks([target.id]).filter((a) => a.forChat).length;
  if (handed >= MAX_CHAT_FILES)
    return { text: `Not sent: the chat gets at most ${MAX_CHAT_FILES} files.`, isError: true };
  const to = { taskId: target.id, forChat: true };
  try {
    const a = input.content
      ? await attachments.save({
          bytes: new TextEncoder().encode(input.content),
          name: input.name as string,
          mediaType: "",
          from: "hatbot",
          ...to,
        })
      : desktop?.configured
        ? await attachments.fromDesktop(
            desktop,
            { path: input.path, download: input.download_id, name: input.name },
            to,
          )
        : null;
    if (!a)
      return { text: "The desktop isn't set up: write the file out with content.", isError: true };
    tasks.addStep(taskId, { kind: "action", name: "send_to_chat", detail: a.name, url: null });
    const via = target.id === taskId ? "" : ` It goes with task #${target.id}'s result.`;
    return {
      text: `Handed "${a.name}" (${a.mediaType}, ${sizeText(a.size)}) to the chat.${via} The bot there gets it with the result; say in your summary what it holds.`,
    };
  } catch (err) {
    if (err instanceof DesktopError) return { text: err.message, isError: true };
    throw err;
  }
}
