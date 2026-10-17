// Haiku screens untrusted text for prompt injection (PLAN.md §6.1, defence in depth): a desktop task's
// pages, and what the chat and background tasks read from the web and from plugins.
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Spend } from "../spend";
import type { ModelClient } from "./model";
import { SCREENING_PROMPT } from "./prompt";
import { tagJson } from "./untrusted";

export const SCREENING_MODEL = "claude-haiku-5-5";

/** `failed`: Haiku gave no verdict, so the page counts as suspected and the owner is asked. */
export type Screening = { suspected: boolean; excerpt: string; failed?: true };

const VERDICT = {
  type: "object",
  properties: { suspected: { type: "boolean" }, excerpt: { type: "string" } },
  required: ["suspected", "excerpt"],
  additionalProperties: false,
};

/** About what a fetched page can be; past it, the text is cut. */
const MAX_SCREENED_CHARS = 150_000;

export async function screenPage(
  model: ModelClient,
  spend: Spend,
  ref: number | { taskId?: number; episodeId?: number },
  page: { url: string | null; title: string | null; text: string },
): Promise<Screening> {
  if (!page.text.trim()) return { suspected: false, excerpt: "" };
  const where = typeof ref === "number" ? { taskId: ref } : ref;
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
          content: `<page_json>\n${tagJson({ url: page.url, title: page.title, text: page.text.slice(0, MAX_SCREENED_CHARS) })}\n</page_json>`,
        },
      ],
    });
    spend.recordResponse({
      model: SCREENING_MODEL,
      purpose: "screening",
      usage: res.usage,
      ...where,
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
    console.error(
      `${where.taskId ? `task ${where.taskId}` : `episode ${where.episodeId}`}: screening failed`,
      err,
    );
    return { suspected: true, excerpt: "", failed: true };
  }
}

/**
 * Verdicts by the text's hash, for every chat and task the model client serves, so text read again
 * isn't screened again.
 */
const known = new WeakMap<ModelClient, Map<string, Screening>>();
const MAX_KNOWN = 1000;

/**
 * Screens the untrusted text a chat reply or a background task reads, in the background while it goes
 * on (PLAN.md §6.1). `settled` waits for the verdicts: a change waits for them before it's reviewed.
 * `suspect` hears of each text Haiku suspects, or couldn't check.
 */
export class Screener {
  private pending = new Set<Promise<void>>();

  constructor(
    private d: { model: ModelClient; spend: Spend },
    private ref: { taskId?: number; episodeId?: number },
    private suspect: (source: string, verdict: Screening) => void,
  ) {}

  /** `source` says where `text` came from, e.g. "Read https://…" or a tool call. */
  add(source: string, text: string) {
    if (!text.trim()) return;
    const key = createHash("sha256").update(text).digest("hex");
    const cache = known.get(this.d.model) ?? new Map<string, Screening>();
    known.set(this.d.model, cache);
    const seen = cache.get(key);
    const verdict = seen
      ? Promise.resolve(seen)
      : screenPage(this.d.model, this.d.spend, this.ref, { url: null, title: source, text }).then(
          (v) => {
            if (v.failed) return v;
            if (cache.size >= MAX_KNOWN) cache.delete(cache.keys().next().value as string);
            cache.set(key, v);
            return v;
          },
        );
    const done: Promise<void> = verdict
      .then((v) => {
        if (v.suspected) this.suspect(source, v);
      })
      .finally(() => this.pending.delete(done));
    this.pending.add(done);
  }

  /** Whether no verdict is pending. */
  get idle() {
    return this.pending.size === 0;
  }

  /** Waits for every verdict so far. */
  async settled() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
