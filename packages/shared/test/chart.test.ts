import { expect, test } from "bun:test";
import { chartProblem, parseChart } from "../src/chart";

test("a chart block parses, or says why not in words the model can fix it from", () => {
  const spec = parseChart(
    '{"type":"line","unit":"GiB","x":["12:00","12:05"],"series":[{"data":[1.1,null]}]}',
  );
  expect(spec?.series[0]?.data).toEqual([1.1, null]);
  // The usual slip: a series a value too long.
  const long =
    '{"type":"line","x":["a","b"],"series":[{"name":"wan","data":[1,2]},{"name":"lan","data":[0,0,0]}]}';
  expect(parseChart(long)).toBeNull();
  expect(chartProblem(long)).toBe('x has 2 values but series "lan" has 3 values');
  // Still streaming.
  expect(parseChart('{"type":"line","x":["a"')).toBeNull();
  expect(chartProblem('{"type":"line","x":["a"')).toStartWith("it isn't valid JSON");
});
