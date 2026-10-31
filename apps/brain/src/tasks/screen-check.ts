// On a computer, a click or key with nothing to say what's under it (no accessibility tree there):
// the small model judges a zoomed screenshot instead.
import type { ScreenAgent } from "@hatbot/plugin-sdk";
import { type ModelClient, oneShot } from "../agent/model";
import { CLICK_CHECK_PROMPT } from "../agent/prompt";
import type { SettingsStore } from "../settings";
import type { Spend } from "../spend";
import type { Hold, Press } from "./policy";

const VERDICT = {
  type: "object",
  properties: { consequential: { type: "boolean" }, label: { type: "string" } },
  required: ["consequential", "label"],
  additionalProperties: false,
};

/** Around the point, in the screenshot's pixels. */
const HALF = { width: 240, height: 140 };

/** How far into from..to `at` is: the zoom is enlarged, and off-centre at the screen's edges. */
const where = (at: number, from: number, to: number) =>
  `${Math.round(((at - from) / Math.max(1, to - from)) * 100)}%`;

/** From..to around `at`, inside 0..`max` when it's known: the agent refuses a region off the screen. */
const span = (at: number, half: number, max?: number) => {
  const from = Math.max(0, max === undefined ? at - half : Math.min(at - half, max - 2 * half));
  return [from, max === undefined ? at + half : Math.min(max, from + 2 * half)] as const;
};

export const mediaTypeOf = (b: Uint8Array) =>
  b[0] === 0xff && b[1] === 0xd8 ? ("image/jpeg" as const) : ("image/webp" as const);

/** A hold for confirm_intent, or null; `unseen` when it couldn't look. */
export async function judgedHold(
  d: { model: ModelClient; spend: Spend; settings: SettingsStore },
  taskId: number,
  screen: ScreenAgent,
  point: number[] | null,
  press: Press,
  reserve = false,
  shot: { width: number; height: number } | null = null,
): Promise<Hold | null> {
  const act = press === "click" ? "click" : press === "space" ? "Space key" : "Enter key";
  try {
    const [x = 0, y = 0] = point ?? [];
    const [x1, x2] = span(x, HALF.width, shot?.width);
    const [y1, y2] = span(y, HALF.height, shot?.height);
    const bytes = point ? await screen.zoom([x1, y1, x2, y2]) : await screen.screenshot();
    const out = await oneShot(
      d,
      {
        model: d.settings.get().smallModel,
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT } },
        system: CLICK_CHECK_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaTypeOf(bytes),
                  data: Buffer.from(bytes).toString("base64"),
                },
              },
              {
                type: "text",
                text: point
                  ? `The ${act} lands ${where(x, x1, x2)} across and ${where(y, y1, y2)} down this picture.`
                  : `This is the whole screen; the ${act} goes to whatever has the keyboard.`,
              },
            ],
          },
        ],
      },
      { purpose: "review", taskId },
      { reserve },
    );
    const v = JSON.parse(out) as { consequential?: unknown; label?: unknown };
    if (v.consequential !== true) return null;
    const label = typeof v.label === "string" ? v.label.trim().slice(0, 60) : "";
    return label ? { label, judged: true } : { unlabelled: "button" };
  } catch (err) {
    console.error(`task ${taskId}: couldn't check the step from a screenshot`, err);
    return { unseen: true };
  }
}
