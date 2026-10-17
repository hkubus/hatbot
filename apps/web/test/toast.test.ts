import { expect, test } from "bun:test";
import { TOAST_ICON } from "../src/toast";

test("only a toast for something done has the check; an error has an alert, news nothing", () => {
  expect(TOAST_ICON.done).toBe("check");
  expect(TOAST_ICON.error).toBe("alert");
  expect(TOAST_ICON.info).toBeNull();
});
