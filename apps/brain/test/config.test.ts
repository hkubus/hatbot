import { expect, test } from "bun:test";
import { loadConfig, urlHost } from "../src/config";

test("the public address is kept as the origin browsers send, and one with a path is refused", () => {
  const origin = (url: string) => loadConfig({ HATBOT_PUBLIC_URL: url }).publicUrl;
  expect(origin("https://Hatbot.Example.com:443/")).toBe("https://hatbot.example.com");
  expect(origin("https://hatbot.example.com")).toBe("https://hatbot.example.com");
  expect(origin("http://192.168.1.5:8080/")).toBe("http://192.168.1.5:8080");
  expect(() => origin("https://example.com/hatbot")).toThrow("only the scheme and host");
  expect(() => origin("https://example.com/?x=1")).toThrow("only the scheme and host");
  expect(() => origin("ftp://example.com")).toThrow("only the scheme and host");
  expect(() => origin("hatbot.example.com")).toThrow("isn't an address");
});

test("an IPv6 address to listen on is taken with or without brackets, and shown in them", () => {
  expect(loadConfig({ HATBOT_HOST: "[::1]" }).host).toBe("::1");
  expect(loadConfig({ HATBOT_HOST: "::" }).host).toBe("::");
  expect(loadConfig({}).host).toBe("127.0.0.1");
  expect(urlHost("::1")).toBe("[::1]");
  expect(urlHost("0.0.0.0")).toBe("0.0.0.0");
});
