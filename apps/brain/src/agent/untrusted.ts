// Untrusted text in a prompt goes between tags as JSON, labelled with where it came from, so it reads
// as data. Every wrapper is built with these, so none can be closed from inside.
import { tagJson } from "@hatbot/plugin-sdk";

/**
 * SQL over `messages m` with TRUST_JOINS. A bot's message is untrusted when the task it shows, or its
 * conversation, had read untrusted content.
 */
export const UNTRUSTED_SOURCE = `CASE WHEN m.role = 'user' THEN NULL ELSE coalesce(m.tainted_by,
  CASE WHEN t.tainted = 1 THEN 'Task #' || t.id || ' "' || t.title || '"' END,
  CASE WHEN e.tainted = 1 THEN coalesce(e.tainted_by, 'Untrusted content') END) END`;
export const TRUST_JOINS =
  "LEFT JOIN episodes e ON e.id = m.episode_id LEFT JOIN tasks t ON t.id = m.task_id";

export function tagText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Its text is escaped so that a line in it can't pass for another message. */
export function messageTag(
  from: string,
  at: string,
  text: string,
  { taintedBy = null, attrs = "" }: { taintedBy?: string | null; attrs?: string } = {},
): string {
  const head = `<message from=${tagJson(from)} at="${at}"${attrs}`;
  return taintedBy
    ? `${head} trusted="false" source=${tagJson(taintedBy)}>${tagJson(text)}</message>`
    : `${head}>${tagText(text)}</message>`;
}
