import { describe, expect, test } from "bun:test";
import { MATCH_END, MATCH_START } from "@hatbot/shared";
import { PRICES } from "../../brain/src/spend";
import { modelName, plainText, usd } from "../src/format";

describe("usd", () => {
  test("cents, and a tiny cost isn't $0.00", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.003)).toBe("<$0.01");
    expect(usd(0.0049)).toBe("<$0.01");
    expect(usd(0.005)).toBe("$0.01");
    expect(usd(0.034)).toBe("$0.03");
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(12)).toBe("$12.00");
  });
});

test("modelName", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-haiku-5-5")).toBe("Haiku 5.5");
  // Opus 5.5's fallbacks, which the ledger keeps under their own ids.
  expect(modelName("claude-opus-5")).toBe("Opus 5");
  expect(modelName("claude-opus-4-8")).toBe("Opus 4.8");
  expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelName("some-new-model")).toBe("some-new-model");
});

test("every model the brain bills has a name, fallbacks too", () => {
  for (const id of Object.keys(PRICES)) expect(modelName(id)).not.toBe(id);
});

describe("plainText", () => {
  const cases: [string, string, string][] = [
    ["bold and italics", "**Disk** at *92%*, __really__ _full_", "Disk at 92%, really full"],
    [
      "a link keeps its words",
      "See [the release notes](https://example.com/notes).",
      "See the release notes.",
    ],
    ["an image keeps its alt", "![router](https://x/y.png) rebooted", "router rebooted"],
    ["inline code", "Ran `systemctl restart nginx`", "Ran systemctl restart nginx"],
    ["headings and lists", "## Found\n- one\n- two\n1. three", "Found one two three"],
    ["quotes and task boxes", "> quoted\n- [x] done\n- [ ] not yet", "quoted done not yet"],
    ["code fences", "```sh\nls -la\n```", "ls -la"],
    ["a rule", "above\n\n---\n\nbelow", "above below"],
    ["a table", "| Host | Disk |\n|---|---:|\n| nas | 92% |", "Host Disk nas 92%"],
    ["strikethrough", "~~$1,299~~ $999", "$1,299 $999"],
    ["snake_case and sums stay", "my_var_name is 2*3*4", "my_var_name is 2*3*4"],
    ["a cut-off snippet", "…the **disk was nearly", "…the disk was nearly"],
    ["cut off after a mark", "was nearly full** and `tank", "was nearly full and tank"],
    ["powers stay", "2**10 = 1024", "2**10 = 1024"],
    ["spaced marks stay", "x ** 2, a ~~ b, use ` to quote", "x ** 2, a ~~ b, use ` to quote"],
  ];
  for (const [name, input, out] of cases) test(name, () => expect(plainText(input)).toBe(out));

  test("search's match marks pass through", () => {
    const snippet = `the **${MATCH_START}disk${MATCH_END}** on [nas](http://nas.lan)`;
    expect(plainText(snippet)).toBe(`the ${MATCH_START}disk${MATCH_END} on nas`);
  });
});
