/**
 * billing/overage.ts
 *
 * The ONE place overage money is computed. Dependency-free and pure so it
 * unit-tests without Prisma/Redis — mirrors stayDuration.ts / period.ts.
 *
 * WHY THIS EXISTS
 * ---------------
 * `extraConversationCharge` / `extraAiReplyCharge` were snapshotted onto every
 * Subscription row and then read by NO computation anywhere in the backend — no
 * invoice, no charge, nothing. The only overage math in the entire product ran
 * **in the browser** (dashboard/subscription/page.tsx computed
 * `convOver * convOverRate + aiOver * aiOverRate` client-side and displayed it
 * as an "estimated" figure).
 *
 * Now: one writer, one reader. The invoice generator and the hotel-facing
 * /billing/usage response both call `computeOverage`, so the number a hotel sees
 * mid-cycle is the number it gets billed. The frontend stops doing money math.
 *
 * CONVENTION: a limit of 0 means UNLIMITED (matches Plan/Subscription schema
 * comments, the admin Plans UI "0 = unlimited" hint, and isOverQuota).
 */

export type UsageCounts = {
  conversationsUsed: number;
  aiRepliesUsed: number;
};

/** The billed terms — a Subscription snapshot row, or a Plan. */
export type OverageTerms = {
  conversationLimit: number;
  aiReplyLimit: number;
  extraConversationCharge: number; // integer minor units per extra unit
  extraAiReplyCharge: number;
};

export type OverageResult = {
  /** Units over the included allowance. 0 when unlimited or within limit. */
  conversationOverage: number;
  aiReplyOverage: number;
  /** Integer minor units. */
  conversationCharge: number;
  aiReplyCharge: number;
  total: number;
};

export const ZERO_OVERAGE: OverageResult = {
  conversationOverage: 0,
  aiReplyOverage: 0,
  conversationCharge: 0,
  aiReplyCharge: 0,
  total: 0,
};

/** Non-finite/negative → 0. Keeps a corrupt row from producing NaN money. */
function safeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Units billed beyond the allowance.
 * `limit <= 0` is unlimited, so nothing is ever billed as overage.
 */
export function unitsOverLimit(used: unknown, limit: unknown): number {
  const lim = safeCount(limit);
  if (lim === 0) return 0; // unlimited
  return Math.max(0, safeCount(used) - lim);
}

/**
 * Overage for one billing period. All money is integer minor units — never a
 * float, so summing across line items can't drift.
 */
export function computeOverage(usage: UsageCounts, terms: OverageTerms): OverageResult {
  const conversationOverage = unitsOverLimit(usage?.conversationsUsed, terms?.conversationLimit);
  const aiReplyOverage = unitsOverLimit(usage?.aiRepliesUsed, terms?.aiReplyLimit);

  const conversationCharge = conversationOverage * safeCount(terms?.extraConversationCharge);
  const aiReplyCharge = aiReplyOverage * safeCount(terms?.extraAiReplyCharge);

  return {
    conversationOverage,
    aiReplyOverage,
    conversationCharge,
    aiReplyCharge,
    total: conversationCharge + aiReplyCharge,
  };
}
