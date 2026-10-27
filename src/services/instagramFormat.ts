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
 *     `https://x.com/a_b_c?q=*y*` is never altered. A marker pair WRAPPING a
 *     URL/email is still stripped: `*https://x.com*` → `https://x.com` (see
 *     urlCoreLength).
 *
 * The passes repeat until nothing changes. Every change removes characters, so
 * this always terminates, and it makes the function idempotent by construction.
 */

// Private-use characters: never whitespace/punctuation/symbol, never in real copy.
const PH_OPEN  = "";
const PH_CLOSE = "";

const URL_RE   = /https?:\/\/\S+/g;
// Local part may not START with `_`/`.`, so an italic opener directly before an
// email ("_mail@x.com_") stays outside the token and can pair.
const EMAIL_RE = /[A-Za-z0-9%+-][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

const MARKER_CHARS = "*_~`";
/** A URL's trailing marker run, plus any non-word punctuation after it ("*!"). */
const TRAILING_CLOSE_RE = /([*_~`]+)([^\w\s*_~`]*)$/;

/**
 * `\S+` swallows a closing marker: in "*https://x.com*" the token is
 * "https://x.com*". When a marker run sits DIRECTLY before the URL, cut off the
 * trailing run that closes it (innermost first: "_*url*_"), plus any
 * punctuation after it, so the pair can form outside the protected token.
 * Underscores inside the URL are never touched, and with no opener directly
 * before the URL nothing is cut ("https://x.com/a_b_" stays whole).
 */
function urlCoreLength(url: string, lead: string): number {
  if (!lead) return url.length;
  const m = TRAILING_CLOSE_RE.exec(url);
  if (!m) return url.length;
  const run   = m[1]!;
  const punct = m[2]!;
  for (let k = Math.min(lead.length, run.length); k >= 1; k--) {
    const closer = [...lead.slice(-k)].reverse().join("");
    if (run.endsWith(closer)) {
      const cut = url.length - punct.length - k;
      // Never cut into the scheme — the core must still be "scheme://something".
      return cut > url.indexOf("://") + 3 ? cut : url.length;
    }
  }
  return url.length;
}

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

  let out = text
    .replace(URL_RE, (url: string, offset: number, whole: string) => {
      let start = offset;
      while (start > 0 && MARKER_CHARS.includes(whole[start - 1]!)) start--;
      const core = urlCoreLength(url, whole.slice(start, offset));
      return protect(url.slice(0, core)) + url.slice(core);
    })
    .replace(EMAIL_RE, protect);

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
