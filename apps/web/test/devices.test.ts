import { expect, test } from "bun:test";
import { installDom } from "./dom";

const dom = installDom();
const { signOut } = await import("../src/pages/Devices");

test("signing out a browser that's signed out already isn't an error", async () => {
  dom.answer(() => {
    throw { status: 404, error: "That browser is already signed out." };
  });
  expect(await signOut(3)).toBeNull();
  expect(dom.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/auth/sessions/3" });
  dom.answer(() => {
    throw { status: 500, error: "Something went wrong." };
  });
  expect(await signOut(3)).toBe("Something went wrong.");
});
