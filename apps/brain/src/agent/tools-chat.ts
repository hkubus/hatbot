import { DESKTOP_TOOLS, INCOGNITO_TOOLS, TOOL_PARAMS } from "../tools";

type Tool = (typeof TOOL_PARAMS)[number];

/** Tools that load only when the model searches for them: about a third of the prompt, for things most conversations never touch. */
const RARE = /^(box|watch|trigger|schedule)_|^run_desktop_task$/;

export type ChatTools = {
  /** False while it's off or not ready: its tools go, and so does a search for them. */
  desktop: boolean;
  boxes: boolean;
  others: boolean;
  incognito: boolean;
  coder: boolean;
  t3: boolean;
};

/** What a chat's request sends, in a fixed order: it's part of the prompt cache. */
export const chatTools = (bot: ChatTools): Tool[] => {
  const out: Tool[] = [];
  for (const t of TOOL_PARAMS) {
    if (
      (bot.incognito && !INCOGNITO_TOOLS.includes(t.name)) ||
      (!bot.desktop && DESKTOP_TOOLS.includes(t.name)) ||
      // Boxes are code: with a code bot, it makes and changes them all.
      (!bot.boxes && t.name.startsWith("box_")) ||
      (bot.coder && t.name.startsWith("box_")) ||
      (!bot.others && t.name === "ask_bot") ||
      (t.name === "box_t3" && !bot.t3)
    )
      continue;
    out.push(RARE.test(t.name) ? { ...t, defer_loading: true } : { ...t });
  }
  return out;
};
