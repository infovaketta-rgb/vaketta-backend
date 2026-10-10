/**
 * ara/ages.ts — children's-age parsing, accumulation and reclassification.
 *
 * All pure. The parse gate (`isBareAgeList`) is an ALLOWLIST of provably-safe
 * shapes — do not re-invert it into a list of "ambiguous" words.
 */

import { AGE_LIST_SEPARATORS } from "./constants";

/**
 * Extract children's ages from free-form guest text. Pulls every integer
 * sequence and keeps those in the child range 0–17, preserving order.
 * Pure + exported for unit testing. Examples:
 *   "6, 9" → [6, 9]   "6 and 9 years" → [6, 9]   "20, 5" → [5]   "no kids" → []
 */
export function parseChildrenAges(raw: string): number[] {
  const matches = raw.match(/\d+/g);
  if (!matches) return [];
  return matches
    .map((m) => parseInt(m, 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 17);
}
/**
 * Read-back text for the collected ages. Pure and exported for testing.
 */
export function renderAgeConfirmation(ages: number[]): string {
  const subject = ages.length === 1 ? "your child is" : `your ${ages.length} children are`;
  return `Just to confirm — ${subject} aged *${formatAges(ages)}*.`;
}

/** Footer used when no interactive button sender is injected. */
export function ageConfirmFooter(): string {
  return "Reply *1* if that's right\nReply *2* to correct the ages\nReply *MENU* to cancel";
}
/**
 * Step 1 of parsing — pull every integer in the child range 0–17 from a reply,
 * preserving order. (Same shape as parseChildrenAges; named for the collection
 * flow where it's the "regex first" step.)
 */
export function extractAgesRegex(reply: string): number[] {
  return parseChildrenAges(reply);
}
/**
 * True when the reply is an UNAMBIGUOUS bare list of ages: after stripping
 * whitespace and the separators above, nothing but digit-runs remains
 * ("5", "5, 8 and 12", "5-8-12").
 *
 * This is the ONLY shape the integer regex may be trusted on, and it replaces
 * the old `needsAiAgeParse` word-list gate. That gate asked the opposite
 * question — "does this reply look ambiguous?" — so it could only ever
 * recognise ambiguity it had been told about in advance. A quantifier reply
 * like "all 5" contains one digit and none of the listed words, so the regex
 * answer [5] was taken as final and the AI was never consulted: the shape that
 * most needed semantic parsing was the shape that could not reach the parser.
 * Inverting the gate into an allowlist of provably-safe shapes means every
 * other shape — quantifiers, prose, embedded counts, stray numbers — routes to
 * the AI by default, and new phrasings need no new words here.
 */
export function isBareAgeList(reply: string): boolean {
  const stripped = reply.replace(AGE_LIST_SEPARATORS, " ").trim();
  if (stripped === "") return false;
  return /^\d+(?:\s+\d+)*$/.test(stripped);
}

export type AgeAccumulation = {
  ages:   number[];                          // collected so far (capped at childrenCount)
  status: "complete" | "partial" | "over";   // vs childrenCount
};

/**
 * Append newly-extracted ages to what's been collected and compare against the
 * expected child count. Pure.
 *   - equal  → "complete"
 *   - fewer  → "partial"
 *   - more   → "over" (take the first childrenCount)
 */
export function accumulateAges(
  collected:     number[],
  incoming:      number[],
  childrenCount: number,
): AgeAccumulation {
  const merged = [...collected, ...incoming];
  if (merged.length === childrenCount) return { ages: merged, status: "complete" };
  if (merged.length <  childrenCount) return { ages: merged, status: "partial" };
  return { ages: merged.slice(0, childrenCount), status: "over" };
}
// ── Reclassification (Task 3) ─────────────────────────────────────────────────

export type ReclassResult = {
  effectiveAdults:       number;
  effectiveChildren:     number;
  effectiveChildrenAges: number[];
  promotedToAdult:       number;
};

/**
 * Children strictly older than `childAgeLimit` are counted as adults. Pure.
 * A null/undefined limit means "no reclassification" (everyone stays as-is).
 */
export function reclassifyGuests(
  adults:        number,
  children:      number,
  childrenAges:  number[],
  childAgeLimit: number | null | undefined,
): ReclassResult {
  if (childAgeLimit == null) {
    return {
      effectiveAdults:       adults,
      effectiveChildren:     children,
      effectiveChildrenAges: [...childrenAges],
      promotedToAdult:       0,
    };
  }
  const promotedToAdult       = childrenAges.filter((a) => a > childAgeLimit).length;
  const effectiveChildrenAges = childrenAges.filter((a) => a <= childAgeLimit);
  return {
    effectiveAdults:   adults + promotedToAdult,
    effectiveChildren: children - promotedToAdult,
    effectiveChildrenAges,
    promotedToAdult,
  };
}
/**
 * WhatsApp-safe occupancy summary (Task 4). Caller sends it only when
 * promotedToAdult > 0. Bold/italic + newlines only — no box-drawing, no headers.
 */
export function buildOccupancyNotice(
  effectiveAdults:   number,
  effectiveChildren: number,
  promotedToAdult:   number,
  childAgeLimit:     number,
): string {
  const who = promotedToAdult > 1
    ? `${promotedToAdult} of your children are`
    : `One of your children is`;
  const counted = promotedToAdult > 1 ? "adults" : "an adult";
  return (
    `*Occupancy Summary* 👥\n\n` +
    `Adults: *${effectiveAdults}*   Children: *${effectiveChildren}*\n\n` +
    `_${who} above ${childAgeLimit} years and will be counted as ${counted} per hotel policy._`
  );
}

/** Join ages for display: [6,9] → "6 & 9", [4,7,12] → "4, 7 & 12". */
export function formatAges(ages: number[]): string {
  if (ages.length <= 1) return ages.join("");
  return `${ages.slice(0, -1).join(", ")} & ${ages[ages.length - 1]}`;
}
