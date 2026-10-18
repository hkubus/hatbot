import { expect, test } from "bun:test";
import { MATCH_END, MATCH_START } from "@hatbot/shared";
import { plainText } from "../src/format";

test("plainText takes out Markdown's marks and only those", () => {
  const cases: [string, string][] = [
    ["**Disk** at *92%*, __really__ _full_", "Disk at 92%, really full"],
    ["See [the release notes](https://example.com/notes).", "See the release notes."],
    ["## Found\n- one\n- [x] two\n> three", "Found one two three"],
    ["```sh\nls -la\n```", "ls -la"],
    // A snippet cut off mid-mark, as search shows them.
    ["was nearly full** and `tank", "was nearly full and tank"],
    [`the **${MATCH_START}disk${MATCH_END}**`, `the ${MATCH_START}disk${MATCH_END}`],
    // Not marks.
    ["my_var_name is 2*3*4", "my_var_name is 2*3*4"],
    ["2**10 = 1024", "2**10 = 1024"],
    ["x ** 2, a ~~ b, use ` to quote", "x ** 2, a ~~ b, use ` to quote"],
  ];
  for (const [input, out] of cases) expect([input, plainText(input)]).toEqual([input, out]);
});
