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
): Promise<Hold | null> {
  const act = press === "click" ? "click" : press === "space" ? "Space key" : "Enter key";
  try {
    const [x = 0, y = 0] = point ?? [];
    const bytes = point
      ? await screen.zoom([
          Math.max(0, x - HALF.width),
          Math.max(0, y - HALF.height),
          x + HALF.width,
          y + HALF.height,
        ])
      : await screen.screenshot();
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
                  ? `The ${act} lands near the middle of this picture.`
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
