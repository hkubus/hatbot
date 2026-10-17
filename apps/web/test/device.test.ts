import { expect, test } from "bun:test";
import { deviceName } from "../src/device";

test("a sign-in is named by its browser and system", () => {
  expect(deviceName("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe(
    "Firefox on Linux",
  );
  expect(
    deviceName(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ),
  ).toBe("Safari on iPhone");
  expect(
    deviceName(
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
    ),
  ).toBe("Chrome on Android");
  expect(
    deviceName(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
    ),
  ).toBe("Edge on Windows");
  expect(
    deviceName(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    ),
  ).toBe("Safari on a Mac");
  expect(deviceName("curl/8.0")).toBe("A browser");
  expect(deviceName(null)).toBe("A browser");
});
