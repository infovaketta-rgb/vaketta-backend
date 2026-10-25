/**
 * ara/money.ts — the single money formatter for the node.
 *
 * Replaces five divergent `inr` copies (advancedRoomAllocation, planList ×3,
 * modifyLists). Currency/locale are still hardwired here; making them read from
 * HotelConfig.currency is a later stage, and this module is the one place that
 * change has to land.
 */

export function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
