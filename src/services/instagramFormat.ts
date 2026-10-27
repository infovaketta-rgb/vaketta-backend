/**
 * instagramFormat.ts
 *
 * Converts WhatsApp-formatted text to plain text for Instagram, which renders
 * no markdown — `*Total: ₹24,000*` would reach the guest with its asterisks.
 *
 * Pure and dependency-free (same shape as instagramMessageSplitter.ts). NOT
 * wired into any send path yet.
 *
 * Rules (mirroring how WhatsApp itself decides what is formatting):
 *   • A marker pair only forms on ONE line.
 *   • Opener: at line start, or after whitespace / punctuation / symbol, and
 *     followed by a non-space character.
 *   • Closer: preceded by a non-space character, and followed by line end,
 *     whitespace, punctuation or symbol.
 *   • A marker never pairs with the same marker beside it, so `__araState__`,
 *     `**x**` and `snake_case` are left alone. An unpaired marker is untouched.
 *   • One marker type per pass: ``` then ` then * then _ then ~, so nesting
 *     like `_Reply *MENU*…_` unwraps from the inside out.
 *   • URLs and emails are swapped for placeholders first and restored last, so
 *     `https://x.com/a_b_c?q=*y*` is never altered.
 *
 * The passes repeat until nothing changes. Every change removes characters, so
 * this always terminates, and it makes the function idempotent by construction.
 */

// Private-use characters: never whitespace/punctuation/symbol, never in real copy.
const PH_OPEN  = "";
const PH_CLOSE = "";

const URL_RE   = /https?:\/\/\S+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Opener/closer boundary: whitespace, punctuation or symbol (incl. emoji). */
const EDGE = "[\\s\\p{P}\\p{S}]";

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the pairing regex for one marker. `ch` is the marker's character,
 *  used to stop it pairing with an identical marker beside it. */
function markerRe(marker: string, ch: string): RegExp {
  const m = esc(marker);
  const c = esc(ch);
  const inner = `[^\\s${c}](?:[^${c}\\n]*?[^\\s${c}])?`;
  return new RegExp(
    `(?<=^|${EDGE})(?<!${c})${m}(${inner})${m}(?=$|${EDGE})(?!${c})`,
    "gmu",
  );
}

const PASSES: RegExp[] = [
  markerRe("```", "`"),
  markerRe("`", "`"),
  markerRe("*", "*"),
  markerRe("_", "_"),
  markerRe("~", "~"),
];

function stripOnce(text: string): string {
  let out = text;
  for (const re of PASSES) out = out.replace(re, "$1");
  return out;
}

export function toInstagramPlainText(text: string): string {
  if (!text) return text;

  const kept: string[] = [];
  const protect = (match: string): string => {
    kept.push(match);
    return `${PH_OPEN}${kept.length - 1}${PH_CLOSE}`;
  };

  let out = text.replace(URL_RE, protect).replace(EMAIL_RE, protect);

  for (;;) {
    const next = stripOnce(out);
    if (next === out) break;
    out = next;
  }

  return out.replace(
    new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"),
    (_, i: string) => kept[Number(i)]!,
  );
}
