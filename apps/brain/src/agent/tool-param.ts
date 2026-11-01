import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
/** `jsonSchema`: an MCP tool's own, which its zod schema only stands in for. */
export const toolParam = (t: {
  name: string;
  description: string;
  schema: z.ZodType;
  jsonSchema?: Record<string, unknown>;
}): Anthropic.Beta.BetaTool => ({
  name: t.name,
  description: t.description,
  input_schema: (t.jsonSchema ??
    z.toJSONSchema(t.schema, { io: "input" })) as Anthropic.Beta.BetaTool.InputSchema,
  eager_input_streaming: true,
});
