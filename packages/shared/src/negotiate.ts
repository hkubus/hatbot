// Haggling with a seller on a marketplace, inside a mandate you approved.

/** Contact details a message may carry when the mandate allows them; otherwise it asks. */
export const MANDATE_CONTACTS = ["phone", "email", "address", "apps"] as const;
export type MandateContact = (typeof MANDATE_CONTACTS)[number];

/** What Hatbot may do on its own in one negotiation. Amounts are in `currency`. */
export type Mandate = {
  currency: string;
  opening: number;
  target: number;
  /** Buying: the most it pays (the ceiling). Selling: the least it takes (the floor). */
  limit: number;
  /** Delivery terms, e.g. "OLX shipping with buyer protection, or pickup in Kraków". */
  delivery: string;
  /** After this, nothing more is sent without asking. */
  expiresAt: string;
  allow: MandateContact[];
};

/** What Hatbot has told the seller about our side, so it doesn't contradict itself. */
export type Claims = {
  /** The most it said it would pay (or the least it would take). */
  max: number | null;
  otherOffers: string | null;
  timing: string | null;
  other: string[];
};

/** What one message claims, as negotiate_send records it. */
export type Stated = Partial<Omit<Claims, "other">> & { other?: string };

/** A price an appraisal rests on: a reference figure or another listing. */
export type AppraisalSource = { label: string; price: number | null; url: string | null };

/** negotiate_appraise's answer, kept for the mandate card. */
export type Appraisal = {
  currency: string;
  asking: number | null;
  opening: number;
  target: number;
  /** Buying: the most worth paying. Selling: the least worth taking. */
  walkAway: number;
  /** One line on how it was worked out. */
  basis: string;
  sources: AppraisalSource[];
  at: string;
};

export type NegotiationStatus =
  | "awaiting_mandate"
  | "open"
  | "agreed"
  | "lost"
  | "abandoned"
  | "expired"
  | "paid"
  | "received";

export type NegotiationMessage = {
  id: number;
  negotiationId: number;
  /** in: the seller's. out: Hatbot's. */
  direction: "in" | "out";
  text: string;
  offer: number | null;
  agree: boolean;
  stated: Stated | null;
  /**
   * out: sending (its desktop task is running), sent, unconfirmed (clicked, but the composer didn't
   * clear), failed (never sent). in: received.
   */
  status: "sending" | "sent" | "unconfirmed" | "failed" | "received";
  /** The desktop task that sends it. */
  taskId: number | null;
  createdAt: string;
  sentAt: string | null;
};

export type Negotiation = {
  id: number;
  botId: string;
  wantId: number;
  /** What you're after, e.g. "RTX 3070, working". */
  want: string;
  role: "buy" | "sell";
  /** `<Marketplace>:<listingId>`, as Scout gives it. */
  listingKey: string;
  listingUrl: string;
  title: string;
  asking: number | null;
  mandate: Mandate;
  appraisal: Appraisal | null;
  conversationUrl: string | null;
  claims: Claims;
  status: NegotiationStatus;
  agreedPrice: number | null;
  /** Its mandate approval: pending while it waits, then the decision and your note. */
  approvalId: number | null;
  conversationId: number | null;
  nextFollowUpAt: string | null;
  lastMessage: NegotiationMessage | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type NegotiationDetail = { negotiation: Negotiation; messages: NegotiationMessage[] };

export const OPEN_NEGOTIATION_STATUSES: NegotiationStatus[] = ["awaiting_mandate", "open"];
