/**
 * greeting.ts
 *
 * Pure matcher for a message that is ONLY a greeting ("hi there", "good
 * morning!", "hello 👋"). Used on first contact to decide between the welcome
 * menu and the AI path. Dependency-free so it unit-tests without botEngine's
 * Prisma/Redis import chain (same reason zeroExempt.ts exists).
 *
 * Deliberately strict: the WHOLE message must be a greeting. "Hi, can I talk
 * to a staff" carries an intent and must NOT match — that is the bug this
 * exists to fix.
 */

const GREETING_WORD =
  "(?:hi+|hello+|hel+o|hlo|hey+|hai|hii+|helo|namaste|namaskar|greetings|good\\s+(?:morning|afternoon|evening|day))";

const ADDRESSEE = "(?:there|team|all|everyone|sir|madam|ma'?am|guys)";

const GREETING_RE = new RegExp(`^${GREETING_WORD}(?:\\s+${GREETING_WORD})*(?:\\s+${ADDRESSEE})?$`, "i");

export function isGreeting(input: string): boolean {
  const cleaned = input
    // Drop punctuation and emoji; keep letters, digits, apostrophes and spaces.
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 40) return false;
  return GREETING_RE.test(cleaned);
}
