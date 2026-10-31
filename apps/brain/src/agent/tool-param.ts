import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
export const toolParam = (t: {
  name: string;
  description: string;
  schema: z.ZodType;
}): Anthropic.Beta.BetaTool => ({
  name: t.name,
  description: t.description,
  input_schema: z.toJSONSchema(t.schema, { io: "input" }) as Anthropic.Beta.BetaTool.InputSchema,
  eager_input_streaming: true,
});
