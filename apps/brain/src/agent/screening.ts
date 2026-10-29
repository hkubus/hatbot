// The small model screens untrusted text for prompt injection, as defence in depth.

import { createHash } from "node:crypto";
import type { Readable } from "@hatbot/plugin-sdk";
import { BudgetError, tagJson } from "@hatbot/plugin-sdk";
import type { SettingsStore } from "../settings";
import type { Spend } from "../spend";
import { type ModelClient, oneShot } from "./model";
import { SCREENING_PROMPT } from "./prompt";

export type { Readable };

/**
 * `failed`: the model gave no verdict, twice. The text isn't suspected for it: the timeline says it
 * couldn't be checked, and the review still looks at what it leads to.
 */
export type Screening = { suspected: boolean; excerpt: string; failed?: true };

const VERDICT = {
  type: "object",
  properties: { suspected: { type: "boolean" }, excerpt: { type: "string" } },
  required: ["suspected", "excerpt"],
  additionalProperties: false,
};

const MAX_SCREENED_CHARS = 150_000;

type ScreenDeps = { model: ModelClient; spend: Spend; settings: SettingsStore };

export async function screenPage(
  d: ScreenDeps,
  where: { taskId?: number; episodeId?: number },
  page: { url: string | null; title: string | null; text: Readable },
  { reserve = false }: { reserve?: boolean } = {},
): Promise<Screening> {
  const pdf = typeof page.text === "string" ? null : page.text.pdf;
  if (typeof page.text === "string" && !page.text.trim()) return { suspected: false, excerpt: "" };
  // JSON-encoded and labelled with its source, so the page can't pose as the prompt.
  const label = `<page_json>\n${tagJson({ url: page.url, title: page.title, text: pdf === null ? (page.text as string).slice(0, MAX_SCREENED_CHARS) : "(the PDF document above)" })}\n</page_json>`;
  // Tried twice: a verdict cut short or garbled may come right the second time. Past a limit, once.
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await oneShot(
        d,
        {
          model: d.settings.get().smallModel,
          // Low effort, with room so thinking can't crowd out the verdict.
          max_tokens: 2000,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT } },
          system: SCREENING_PROMPT,
          messages: [
            {
              role: "user",
              content:
                pdf === null
                  ? label
                  : [
                      {
                        type: "document",
                        source: { type: "base64", media_type: "application/pdf", data: pdf },
                      },
                      { type: "text", text: label },
                    ],
            },
          ],
        },
        { purpose: "screening", ...where },
        { reserve },
      );
      const parsed = JSON.parse(out) as Partial<Screening>;
      if (typeof parsed.suspected !== "boolean")
        throw new Error(`no verdict in ${out.slice(0, 200)}`);
      return { suspected: parsed.suspected, excerpt: String(parsed.excerpt ?? "").slice(0, 300) };
    } catch (err) {
      if (attempt < 2 && !(err instanceof BudgetError)) continue;
      console.error(
        `${where.taskId ? `task ${where.taskId}` : `episode ${where.episodeId}`}: screening failed`,
        err,
      );
      return { suspected: false, excerpt: "", failed: true };
    }
  }
}

/** Shared by every chat and task the model client serves, so text read again isn't screened again. */
const known = new WeakMap<ModelClient, Map<string, Screening>>();
const MAX_KNOWN = 1000;

/** Screens in the background while the work goes on; a change waits for `settled` before it's reviewed. */
export class Screener {
  private pending = new Set<Promise<void>>();

  constructor(
    private d: ScreenDeps,
    private ref: { taskId?: number; episodeId?: number },
    private suspect: (source: string, verdict: Screening) => void,
    private opts: { reserve?: boolean } = {},
  ) {}

  add(source: string, text: Readable) {
    if (typeof text === "string" ? !text.trim() : !text.pdf) return;
    const key = createHash("sha256")
      .update(typeof text === "string" ? text : `pdf:${text.pdf}`)
      .digest("hex");
    const cache = known.get(this.d.model) ?? new Map<string, Screening>();
    known.set(this.d.model, cache);
    const seen = cache.get(key);
    const verdict = seen
      ? Promise.resolve(seen)
      : screenPage(this.d, this.ref, { url: null, title: source, text }, this.opts).then((v) => {
          if (v.failed) return v;
          if (cache.size >= MAX_KNOWN) cache.delete(cache.keys().next().value as string);
          cache.set(key, v);
          return v;
        });
    const done: Promise<void> = verdict
      .then((v) => {
        if (v.suspected || v.failed) this.suspect(source, v);
      })
      .finally(() => this.pending.delete(done));
    this.pending.add(done);
  }

  get idle() {
    return this.pending.size === 0;
  }

  async settled() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
