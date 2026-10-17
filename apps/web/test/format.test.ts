import { describe, expect, test } from "bun:test";
import { modelName, usd } from "../src/format";

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
  expect(modelName("some-new-model")).toBe("some-new-model");
});
