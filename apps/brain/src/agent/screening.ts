// Haiku screens untrusted page text for prompt injection (PLAN.md §6.1, defence in depth).
import type Anthropic from "@anthropic-ai/sdk";
import type { Spend } from "../spend";
import type { ModelClient } from "./model";
import { SCREENING_PROMPT } from "./prompt";

export const SCREENING_MODEL = "claude-haiku-4-5";

export type Screening = { suspected: boolean; excerpt: string };

export async function screenPage(
  model: ModelClient,
  spend: Spend,
  taskId: number,
  page: { url: string | null; title: string | null; text: string },
): Promise<Screening> {
  if (!page.text.trim()) return { suspected: false, excerpt: "" };
  const res = await model.create({
    model: SCREENING_MODEL,
    max_tokens: 400,
    system: SCREENING_PROMPT,
    // JSON-encoded and labelled with its source, so the page can't pose as the prompt.
    messages: [
      {
        role: "user",
        content: `<page_json>\n${JSON.stringify({ url: page.url, title: page.title, text: page.text })}\n</page_json>`,
      },
    ],
  });
  spend.recordResponse({ model: SCREENING_MODEL, purpose: "screening", usage: res.usage, taskId });
  const out = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const json = /\{[\s\S]*\}/.exec(out)?.[0];
  try {
    const parsed = JSON.parse(json ?? "") as Partial<Screening>;
    return {
      suspected: parsed.suspected === true,
      excerpt: String(parsed.excerpt ?? "").slice(0, 300),
    };
  } catch {
    console.error("screening reply wasn't JSON:", out.slice(0, 200));
    return { suspected: false, excerpt: "" };
  }
}
