// Haiku screens untrusted page text for prompt injection (PLAN.md §6.1, defence in depth).
import type Anthropic from "@anthropic-ai/sdk";
import type { Spend } from "../spend";
import type { ModelClient } from "./model";
import { SCREENING_PROMPT } from "./prompt";

export const SCREENING_MODEL = "claude-haiku-5-5";

/** `failed`: Haiku gave no verdict, so the page counts as suspected and the owner is asked. */
export type Screening = { suspected: boolean; excerpt: string; failed?: true };

const VERDICT = {
  type: "object",
  properties: { suspected: { type: "boolean" }, excerpt: { type: "string" } },
  required: ["suspected", "excerpt"],
  additionalProperties: false,
};

export async function screenPage(
  model: ModelClient,
  spend: Spend,
  taskId: number,
  page: { url: string | null; title: string | null; text: string },
): Promise<Screening> {
  if (!page.text.trim()) return { suspected: false, excerpt: "" };
  try {
    const res = await model.create({
      model: SCREENING_MODEL,
      // Haiku 5.5 thinks by default; low effort, with room so thinking can't crowd out the verdict.
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT } },
      system: SCREENING_PROMPT,
      // JSON-encoded and labelled with its source, so the page can't pose as the prompt.
      messages: [
        {
          role: "user",
          content: `<page_json>\n${JSON.stringify({ url: page.url, title: page.title, text: page.text })}\n</page_json>`,
        },
      ],
    });
    spend.recordResponse({
      model: SCREENING_MODEL,
      purpose: "screening",
      usage: res.usage,
      taskId,
    });
    if (res.stop_reason !== "end_turn") throw new Error(`it stopped at ${res.stop_reason}`);
    const out = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = JSON.parse(out) as Partial<Screening>;
    if (typeof parsed.suspected !== "boolean")
      throw new Error(`no verdict in ${out.slice(0, 200)}`);
    return { suspected: parsed.suspected, excerpt: String(parsed.excerpt ?? "").slice(0, 300) };
  } catch (err) {
    console.error(`task ${taskId}: page screening failed`, err);
    return { suspected: true, excerpt: "", failed: true };
  }
}
