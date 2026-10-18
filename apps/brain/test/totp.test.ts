import { expect, test } from "bun:test";
import { base32Encode, totpAt, verifyTotp } from "../src/auth/totp";

test("codes are RFC 6238's, so any authenticator app agrees, and one step of drift is let through, not two", () => {
  // Appendix B, SHA-1 secret "12345678901234567890", at 59 s and past 2^31 s.
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  expect(totpAt(secret, Math.floor(59 / 30), 8)).toBe("94287082");
  expect(totpAt(secret, Math.floor(2000000000 / 30), 8)).toBe("69279037");

  const now = 1_800_000_000_000;
  const step = Math.floor(now / 30_000);
  expect(verifyTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
  expect(verifyTotp(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
  expect(verifyTotp(secret, totpAt(secret, step - 2), now)).toBeNull();
});
