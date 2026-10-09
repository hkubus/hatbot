import { expect, test } from "bun:test";
import { base32Decode, base32Encode, totpAt, verifyTotp } from "../src/auth/totp";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890".
const SECRET = base32Encode(Buffer.from("12345678901234567890"));

test.each([
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
])("RFC 6238 vector at %i", (t, expected) => {
  expect(totpAt(SECRET, Math.floor(t / 30), 8)).toBe(expected);
});

test("base32 round-trips", () => {
  const buf = Buffer.from("hello hatbot");
  expect(base32Decode(base32Encode(buf))).toEqual(buf);
});

test("accepts one step of drift, not two", () => {
  const now = 1_800_000_000_000;
  const step = Math.floor(now / 30_000);
  expect(verifyTotp(SECRET, totpAt(SECRET, step - 1), now)).toBe(step - 1);
  expect(verifyTotp(SECRET, totpAt(SECRET, step + 1), now)).toBe(step + 1);
  expect(verifyTotp(SECRET, totpAt(SECRET, step - 2), now)).toBeNull();
});
