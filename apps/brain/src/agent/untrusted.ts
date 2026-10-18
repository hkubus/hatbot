// Untrusted text in a prompt (PLAN.md §6.1) goes between tags as JSON, labelled with where it came
// from, so it reads as data. Every wrapper is built with these, so none can be closed from inside.

/**
 * `value` as JSON that can't end the tag it sits in, or open another: every `<` is escaped. It's still
 * valid JSON. `>` and `&` stay as they are, so commands like `cmd 2>&1` read plainly in a review.
 */
export function tagJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c");
}

/** Untrusted text as data: `<tag from="…" trusted="false">"…"</tag>`. */
export function untrustedBlock(
  tag: string,
  text: string,
  attrs: Record<string, string> = {},
): string {
  return untrustedFields(tag, tagJson(text), attrs);
}

/**
 * Several untrusted values in one block, laid out by the caller (research's findings, say): each
 * value in `body` must be in tagJson already, so none can close the block or open another.
 */
export function untrustedFields(
  tag: string,
  body: string,
  attrs: Record<string, string> = {},
): string {
  const named = Object.entries(attrs)
    .map(([k, v]) => ` ${k}=${tagJson(v)}`)
    .join("");
  return `<${tag}${named} trusted="false">\n${body}\n</${tag}>`;
}

/**
 * What a chat message's text came from when that was untrusted, else NULL, as SQL over `messages m`
 * with TRUST_JOINS. The owner's own words are trusted. A note names what it quotes; a bot's message
 * is untrusted when the task it shows, or its conversation, had read untrusted content (PLAN.md §6.1).
 */
export const UNTRUSTED_SOURCE = `CASE WHEN m.role = 'user' THEN NULL ELSE coalesce(m.tainted_by,
  CASE WHEN t.tainted = 1 THEN 'Task #' || t.id || ' "' || t.title || '"' END,
  CASE WHEN e.tainted = 1 THEN coalesce(e.tainted_by, 'Untrusted content') END) END`;
export const TRUST_JOINS =
  "LEFT JOIN episodes e ON e.id = m.episode_id LEFT JOIN tasks t ON t.id = m.task_id";

/** Text between tags that isn't JSON: `&` and `<` escaped, so it can't close its tag or open another. */
export function tagText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * A message in a transcript the model reads: who wrote it and when, its text escaped so that a line in
 * it can't pass for another message. One whose text came from untrusted content (`taintedBy`) says so,
 * and its text is quoted. `attrs`: more of the tag, e.g. ` task="12"`.
 */
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
