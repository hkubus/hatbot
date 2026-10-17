import { expect, test } from "bun:test";
import type { Negotiation } from "@hatbot/shared";
import { negotiationText } from "../src/negotiations";

const expired = (closedAt: string): Negotiation => ({
  id: 1,
  botId: "hatbot",
  wantId: 1,
  want: "An RTX 3070",
  role: "buy",
  listingKey: "OLX:1",
  listingUrl: "https://www.olx.pl/d/oferta/x-ID1.html",
  title: "RTX 3070",
  asking: 1500,
  mandate: {
    currency: "PLN",
    opening: 1000,
    target: 1200,
    limit: 1400,
    delivery: "OLX delivery",
    expiresAt: "2026-10-16T12:00:00.000Z",
    allow: [],
  },
  appraisal: null,
  conversationUrl: null,
  claims: { max: null, otherOffers: null, timing: null, other: [] },
  status: "expired",
  agreedPrice: null,
  approvalId: null,
  conversationId: null,
  nextFollowUpAt: null,
  lastMessage: null,
  createdAt: "2026-10-09T12:00:00.000Z",
  updatedAt: closedAt,
  closedAt,
});

test("an expired negotiation says whether its mandate ran out or was never approved", () => {
  expect(negotiationText(expired("2026-10-16T12:01:00.000Z"))).toBe("The mandate ran out.");
  expect(negotiationText(expired("2026-10-10T12:00:00.000Z"))).toBe(
    "The mandate wasn't approved in time.",
  );
});
