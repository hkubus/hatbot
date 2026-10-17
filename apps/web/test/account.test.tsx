import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./dom";

const dom = installDom();
const { signOut } = await import("../src/pages/Account");
const { AddToAuthenticator } = await import("../src/pages/Login");

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

test("a new authenticator can be added on this device: a link, and the secret in fours to copy", () => {
  const html = renderToStaticMarkup(
    <AddToAuthenticator uri="otpauth://totp/Hatbot:owner?secret=ABCDEFGHIJ" secret="ABCDEFGHIJ" />,
  );
  expect(html).toContain('href="otpauth://totp/Hatbot:owner?secret=ABCDEFGHIJ"');
  expect(html).toContain(">Add to authenticator</a>");
  expect(html).toContain(">ABCD EFGH IJ</code>");
  expect(html).toContain(">Copy</button>");
});
