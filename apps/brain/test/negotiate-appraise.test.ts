import { expect, test } from "bun:test";
import { type PluginTool, z } from "@hatbot/plugin-sdk";
import { appraise, scoutTool } from "../src/negotiate/appraise";

const detail = (asking: number, typical: number): PluginTool => ({
  name: "mcp_scout_scout_listing_detail",
  description: "",
  schema: z.object({ key: z.string() }),
  access: "read",
  run: async () =>
    JSON.stringify({
      listing: { url: "https://www.olx.pl/d/oferta/x-ID1001.html", price: asking, typical },
    }),
});

const opening = async (asking: number, typical: number) =>
  (
    await appraise(
      [detail(asking, typical)],
      "OLX:1001",
      AbortSignal.timeout(5000),
      new Date("2026-10-31T12:00:00Z"),
    )
  ).appraisal;

test("the opening offer is 90% of the asking price, or the target when that's lower", async () => {
  expect(await opening(1000, 1200)).toMatchObject({ opening: 900, target: 1000, walkAway: 1000 });
  // Priced far above the market: it opens at the target, not past it.
  expect(await opening(1500, 1000)).toMatchObject({ opening: 900, target: 900, walkAway: 1000 });
});

test("the Scout plugin's own tool comes before an MCP server's one of the same name", () => {
  const tool = (name: string): PluginTool => ({ ...detail(1, 1), name });
  const mcp = tool("mcp_scout_scout_record_outcome");
  const own = tool("scout_record_outcome");
  expect(scoutTool([mcp, own], "scout_record_outcome")).toBe(own);
  expect(scoutTool([mcp], "scout_record_outcome")).toBe(mcp);
  expect(scoutTool([mcp], "record_outcome")).toBe(mcp);
});
