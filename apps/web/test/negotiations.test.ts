import { expect, test } from "bun:test";
import type { Negotiation } from "@hatbot/shared";
import { negotiationText } from "../src/negotiations";

const expired = (closedAt: string) =>
  ({
    status: "expired",
    mandate: { currency: "PLN", expiresAt: "2026-10-16T12:00:00.000Z" },
    closedAt,
  }) as Negotiation;

test("an expired negotiation says whether its mandate ran out or was never approved", () => {
  expect(negotiationText(expired("2026-10-16T12:01:00.000Z"))).toBe("The mandate ran out.");
  expect(negotiationText(expired("2026-10-10T12:00:00.000Z"))).toBe(
    "The mandate wasn't approved in time.",
  );
});
