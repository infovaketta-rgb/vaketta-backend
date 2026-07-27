/**
 * guestDate.ts
 *
 * Pure, timezone-correct parsing of guest-typed dates into calendar-day strings
 * (YYYY-MM-DD). Kept dependency-free apart from chrono-node — imports NO app
 * modules — so it can be unit-tested without flowRuntime's heavy load chain
 * (Redis throws at import when REDIS_URL is unset, plus Prisma/queues/AI).
 * Mirrors stayDuration.ts / bookingAllocation.ts.
 *
 * ── Why this module exists (three real bugs it fixes) ───────────────────────
 *
 * 1. "day after tomorrow" resolved to TOMORROW. chrono-node has no rule for the
 *    bare phrase; it matched only the `tomorrow` substring. So check-in
 *    "Tomorrow" and check-out "Day after tomorrow" produced the SAME date,
 *    nights === 0, and the guest got "Check-out must be after check-in. Please
 *    start over from the main menu." mid-booking. (chrono only handles it with
 *    the leading article: "THE day after tomorrow".) Fixed by RELATIVE_DAY_WORDS
 *    below, which runs BEFORE chrono and owns the whole class of phrases.
 *
 * 2. Day-shift near midnight. chrono returns a Date in SERVER-LOCAL time
 *    carrying the current wall-clock; the old code then did
 *    `.toISOString().slice(0,10)`, reinterpreting that instant as UTC. On an
 *    IST server at 00:18, "today" stored YESTERDAY's date. Every date is now
 *    resolved against the HOTEL's timezone and formatted with Intl in that same
 *    zone — the instant is never reinterpreted in another zone.
 *
 * 3. DD/MM/YYYY silently read as MM/DD. chrono defaults to the US parser, so
 *    "05/06/2026" became May 6 rather than 6 June — while CLAUDE.md and the
 *    bot's own error copy ("Try something like *25/05/2026*") promise DD/MM.
 *    Unambiguous inputs (25/05) happened to work only because 25 is not a valid
 *    month. Numeric slash/dash dates are now parsed explicitly as DD/MM/YYYY
 *    before chrono ever sees them.
 */

import * as chrono from "chrono-node";

/** A calendar day with no time and no zone — the only thing a booking date is. */
export type DateStr = string; // "YYYY-MM-DD"

const DAY_MS = 86_400_000;

// ── Timezone-aware calendar-day helpers ──────────────────────────────────────

/**
 * The calendar date in `timeZone` at instant `now`, as YYYY-MM-DD.
 * Uses "en-CA" because it formats as YYYY-MM-DD natively. Falls back to UTC if
 * the zone string is invalid (same defensive posture as shouldAutoReply.ts).
 */
export function todayInTZ(timeZone: string, now: Date = new Date()): DateStr {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Parse "YYYY-MM-DD" into UTC-midnight ms. NaN if malformed. */
function dayStrToMs(s: DateStr): number {
  return Date.parse(`${s}T00:00:00Z`);
}

/** Shift a YYYY-MM-DD by whole days. Zone-free: pure calendar arithmetic. */
export function addDays(day: DateStr, n: number): DateStr {
  const ms = dayStrToMs(day);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). NaN-safe → 0. */
export function daysBetween(from: DateStr, to: DateStr): number {
  const a = dayStrToMs(from);
  const b = dayStrToMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

// ── Layer 1: explicit relative-day phrases ───────────────────────────────────

/**
 * Offsets in days from "today". Ordered longest-phrase-first at match time so
 * "day after tomorrow" can never be shadowed by "tomorrow".
 *
 * These are matched BEFORE chrono precisely because chrono gets #1 wrong — and
 * because these are the phrases guests actually type, so resolving them here is
 * both a correctness fix and a latency win (no AI fallback, no chrono pass).
 */
const RELATIVE_DAY_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:the\s+)?day\s+after\s+(?:the\s+)?tomorrow$/, 2],
  [/^(?:the\s+)?days?\s+after\s+(?:the\s+)?tmrw$/, 2],
  [/^(?:the\s+)?day\s+before\s+(?:the\s+)?yesterday$/, -2],
  [/^overmorrow$/, 2],
  [/^(?:day\s+)?after\s+tomorrow$/, 2],
  [/^tomorrow$/, 1],
  [/^tommorow$/, 1], // common misspellings — guests type these constantly
  [/^tommorrow$/, 1],
  [/^tomorow$/, 1],
  [/^tmrw$/, 1],
  [/^tmr$/, 1],
  [/^tom$/, 1],
  [/^next\s+day$/, 1],
  [/^today$/, 0],
  [/^tday$/, 0],
  [/^now$/, 0],
  [/^tonight$/, 0],
  [/^this\s+(?:day|evening|afternoon|morning)$/, 0],
  [/^yesterday$/, -1],
  [/^in\s+(\d{1,3})\s+days?$/, NaN], // captured offset — see resolveRelativeDay
  [/^(\d{1,3})\s+days?\s+(?:from\s+now|later|ahead)$/, NaN],
  [/^after\s+(\d{1,3})\s+days?$/, NaN],
];

/**
 * Resolve a bare relative-day phrase to a calendar day in `today`'s frame.
 * Returns null when the input is not one of these phrases (caller falls through
 * to the numeric and chrono layers).
 */
export function resolveRelativeDay(input: string, today: DateStr): DateStr | null {
  const s = normalize(input);
  for (const [re, fixedOffset] of RELATIVE_DAY_WORDS) {
    const m = s.match(re);
    if (!m) continue;
    const offset = Number.isNaN(fixedOffset) ? parseInt(m[1] ?? "", 10) : fixedOffset;
    if (!Number.isFinite(offset)) return null;
    return addDays(today, offset);
  }
  return null;
}

/** Lowercase, strip punctuation/filler, collapse whitespace. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/^(?:on|for|from|at|its|it's|is|check\s*-?\s*(?:in|out)(?:\s+is)?)\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Layer 2: explicit numeric dates (DD/MM/YYYY — never MM/DD) ───────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/** True if y-m-d is a real calendar date (rejects 31/02, month 13, etc). */
function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Expand a 2-digit year to 20xx; pass 4-digit years through. */
function expandYear(raw: string): number {
  const n = parseInt(raw, 10);
  return raw.length <= 2 ? 2000 + n : n;
}

/**
 * Parse an explicit numeric or month-name date.
 *
 * Numeric slash/dash/dot forms are ALWAYS day-first (DD/MM/YYYY) — this is the
 * documented contract and what the bot's error copy tells guests to type. The
 * one exception is the ISO form YYYY-MM-DD, which is unambiguous by its shape.
 *
 * A missing year resolves to the nearest future occurrence relative to `today`,
 * so "25 May" in December means next May, not a date 11 months in the past.
 */
export function parseExplicitDate(input: string, today: DateStr): DateStr | null {
  const s = normalize(input).replace(/(\d)(?:st|nd|rd|th)\b/g, "$1");

  // ISO: YYYY-MM-DD (unambiguous by shape)
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const [y, m, d] = [+iso[1]!, +iso[2]!, +iso[3]!];
    return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }

  // DD/MM/YYYY | DD-MM-YY | DD.MM.YYYY — day-first, always.
  const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmy) {
    const d = +dmy[1]!;
    const m = +dmy[2]!;
    const y = expandYear(dmy[3]!);
    return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }

  // DD/MM (no year) — nearest future occurrence.
  const dm = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (dm) return nearestFuture(+dm[1]!, +dm[2]!, today);

  // "25 May 2026" | "25 May" | "May 25 2026" | "May 25"
  const dMonY = s.match(/^(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{2,4}))?$/);
  if (dMonY && MONTHS[dMonY[2]!]) {
    const d = +dMonY[1]!;
    const m = MONTHS[dMonY[2]!]!;
    if (dMonY[3]) {
      const y = expandYear(dMonY[3]);
      return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
    }
    return nearestFuture(d, m, today);
  }

  const monDY = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:\s+(\d{2,4}))?$/);
  if (monDY && MONTHS[monDY[1]!]) {
    const m = MONTHS[monDY[1]!]!;
    const d = +monDY[2]!;
    if (monDY[3]) {
      const y = expandYear(monDY[3]);
      return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
    }
    return nearestFuture(d, m, today);
  }

  return null;
}

/** The next occurrence of day/month on or after `today` (this year, else next). */
function nearestFuture(d: number, m: number, today: DateStr): DateStr | null {
  const year = parseInt(today.slice(0, 4), 10);
  for (const y of [year, year + 1]) {
    if (!isRealDate(y, m, d)) continue;
    const candidate = `${y}-${pad(m)}-${pad(d)}`;
    if (candidate >= today) return candidate;
  }
  return isRealDate(year, m, d) ? `${year}-${pad(m)}-${pad(d)}` : null;
}

// ── Layer 3: chrono, anchored to the hotel's calendar day ────────────────────

/**
 * Run chrono with a reference instant pinned to NOON of the hotel's current
 * calendar day, then read the result back as a calendar day.
 *
 * Noon matters: chrono does arithmetic on the reference Date in SERVER-local
 * time, so anchoring at midnight leaves any sub-day drift free to cross a date
 * boundary. Noon keeps a ±12h margin, so the extracted y/m/d is the hotel's
 * intended day regardless of the server's zone.
 *
 * We read the components with getFullYear/getMonth/getDate (server-local, the
 * same frame chrono computed in) — NOT toISOString(), which would reinterpret
 * the instant as UTC and reintroduce bug #2.
 */
export function parseWithChrono(input: string, today: DateStr): DateStr | null {
  const refMs = dayStrToMs(today);
  if (!Number.isFinite(refMs)) return null;

  // Local-time noon on the hotel's current calendar day.
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const ref = new Date(y, m - 1, d, 12, 0, 0, 0);

  let result: Date | null = null;
  try {
    result = chrono.parseDate(input.trim(), ref, { forwardDate: true }) ?? null;
  } catch {
    return null;
  }
  if (!result || Number.isNaN(result.getTime())) return null;

  return `${result.getFullYear()}-${pad(result.getMonth() + 1)}-${pad(result.getDate())}`;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse guest text into a calendar day, in the hotel's timezone.
 *
 * Layer order is deliberate — each layer owns a class of input that a later
 * layer would get WRONG, not merely fail on:
 *   1. relative-day phrases  ("day after tomorrow" — chrono answers, wrongly)
 *   2. explicit numeric/month dates ("05/06/2026" — chrono answers US-style)
 *   3. chrono ("next friday", "this weekend", "in two weeks")
 * Returns null if nothing matched; the caller may then try the AI fallback.
 */
export function parseGuestDateStr(
  input: string,
  timeZone: string,
  now: Date = new Date(),
): DateStr | null {
  if (!input || !input.trim()) return null;
  const today = todayInTZ(timeZone, now);

  return (
    resolveRelativeDay(input, today) ??
    parseExplicitDate(input, today) ??
    parseWithChrono(input, today)
  );
}
