import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

test("the public address is kept as the origin browsers send, and one with a path is refused", () => {
  const origin = (url: string) => loadConfig({ HATBOT_PUBLIC_URL: url }).publicUrl;
  // It's what a browser's Origin header is compared with, for every change.
  expect(origin("https://Hatbot.Example.com:443/")).toBe("https://hatbot.example.com");
  expect(() => origin("https://example.com/hatbot")).toThrow("only the scheme and host");
});
