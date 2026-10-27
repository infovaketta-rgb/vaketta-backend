import { describe, it, expect } from "vitest";
import { toInstagramPlainText } from "./instagramFormat";

// Verbatim output of ara/render.ts renderAllocationSummary (2 rooms, extra adult
// + extra bed, children ages, childAgeLimit 12) + confirmPromptFooter(). Copied,
// not imported, so this suite never depends on ARA.
const ARA_CARD =
  "🛏 *Suggested Allocation*\n" +
  "━━━━━━━━━━━━━━━━\n" +
  "*Room 1: Deluxe Cottage*\n" +
  "👥 3 adults\n" +
  "🛏 Extra bed included\n" +
  "💰 ₹5,000 base + ₹1,500 extra adult + ₹500 extra bed\n" +
  "   = ₹7,000/night × 2 nights = *₹14,000*\n" +
  "*Room 2: Sea View Villa*\n" +
  "👥 2 adults, children aged 6 & 9\n" +
  "💰 ₹5,000/night × 2 nights = *₹10,000*\n" +
  "━━━━━━━━━━━━━━━━\n" +
  "*Total: ₹24,000*\n" +
  "_Note: Children above 12 years are charged as adults._\n" +
  "\n" +
  "Reply *1* to Confirm\n" +
  "Reply *2* to Modify manually\n" +
  "Reply *MENU* to cancel";

const ARA_CARD_PLAIN =
  "🛏 Suggested Allocation\n" +
  "━━━━━━━━━━━━━━━━\n" +
  "Room 1: Deluxe Cottage\n" +
  "👥 3 adults\n" +
  "🛏 Extra bed included\n" +
  "💰 ₹5,000 base + ₹1,500 extra adult + ₹500 extra bed\n" +
  "   = ₹7,000/night × 2 nights = ₹14,000\n" +
  "Room 2: Sea View Villa\n" +
  "👥 2 adults, children aged 6 & 9\n" +
  "💰 ₹5,000/night × 2 nights = ₹10,000\n" +
  "━━━━━━━━━━━━━━━━\n" +
  "Total: ₹24,000\n" +
  "Note: Children above 12 years are charged as adults.\n" +
  "\n" +
  "Reply 1 to Confirm\n" +
  "Reply 2 to Modify manually\n" +
  "Reply MENU to cancel";

/** [input, expected] — every fixture in this file, reused by the idempotence check. */
const CASES: Array<[string, string]> = [
  [ARA_CARD, ARA_CARD_PLAIN],
  ["Welcome to *Maadathil Cottages*! 🏨", "Welcome to Maadathil Cottages! 🏨"],
  ["_Reply *MENU* to see all options._", "Reply MENU to see all options."],
  ["*Plan 1* _(Best value)_", "Plan 1 (Best value)"],
  ["_Note: Children above 12 years are charged as adults._", "Note: Children above 12 years are charged as adults."],
  ["~cancelled~ and *bold*", "cancelled and bold"],
  ["Use ```code here``` and `inline` please", "Use code here and inline please"],
  ["https://example.com/path_with_under/*star*?q=_x_&r=*y*", "https://example.com/path_with_under/*star*?q=_x_&r=*y*"],
  ["Review us: https://g.page/r/abc_def*x* — *thanks*!", "Review us: https://g.page/r/abc_def*x* — thanks!"],
  ["Mail john_doe@maadathil.com or *call*", "Mail john_doe@maadathil.com or call"],
  ["snake_case_word", "snake_case_word"],
  ["2 * 3 = 6", "2 * 3 = 6"],
  ["₹7,000 × 1", "₹7,000 × 1"],
  ["__araState__", "__araState__"],
  ["5* hotel", "5* hotel"],
  ["a_b", "a_b"],
  ["*bold\nacross lines*", "*bold\nacross lines*"],
  ["_open\nclose_", "_open\nclose_"],
  ["**double**", "**double**"],
  ["", ""],
  // Markers wrapping a URL / email
  ["*https://x.com*", "https://x.com"],
  ["_https://g.page/r/abc_def_", "https://g.page/r/abc_def"],
  ["Review us: *https://x.com/a_b*!", "Review us: https://x.com/a_b!"],
  ["https://x.com/a_b_", "https://x.com/a_b_"],
  ["*mail@x.com*", "mail@x.com"],
  ["_mail@x.com_", "mail@x.com"],
  ["_*https://x.com/a_b*_", "https://x.com/a_b"],
  ["*https://x.com_", "*https://x.com_"],
];

describe("toInstagramPlainText", () => {
  it("strips the full ARA allocation card, keeping emoji, dividers, ₹ and × intact", () => {
    expect(toInstagramPlainText(ARA_CARD)).toBe(ARA_CARD_PLAIN);
  });

  it("welcome text", () => {
    expect(toInstagramPlainText("Welcome to *Maadathil Cottages*! 🏨")).toBe("Welcome to Maadathil Cottages! 🏨");
  });

  it("nested markers unwrap: italic around bold", () => {
    expect(toInstagramPlainText("_Reply *MENU* to see all options._")).toBe("Reply MENU to see all options.");
  });

  it("adjacent bold and italic-with-parentheses", () => {
    expect(toInstagramPlainText("*Plan 1* _(Best value)_")).toBe("Plan 1 (Best value)");
  });

  it("age-limit note", () => {
    expect(toInstagramPlainText("_Note: Children above 12 years are charged as adults._"))
      .toBe("Note: Children above 12 years are charged as adults.");
  });

  it("strike, triple-backtick and inline code markers", () => {
    expect(toInstagramPlainText("~cancelled~ and *bold*")).toBe("cancelled and bold");
    expect(toInstagramPlainText("Use ```code here``` and `inline` please")).toBe("Use code here and inline please");
  });

  describe("never alters", () => {
    it("a URL containing underscores and asterisks", () => {
      const url = "https://example.com/path_with_under/*star*?q=_x_&r=*y*";
      expect(toInstagramPlainText(url)).toBe(url);
    });

    it("a URL inside a sentence, while still stripping the sentence", () => {
      expect(toInstagramPlainText("Review us: https://g.page/r/abc_def*x* — *thanks*!"))
        .toBe("Review us: https://g.page/r/abc_def*x* — thanks!");
    });

    it("an email address", () => {
      expect(toInstagramPlainText("Mail john_doe@maadathil.com or *call*")).toBe("Mail john_doe@maadathil.com or call");
    });

    it.each(["snake_case_word", "__araState__", "**double**"])("%j", (s) => {
      expect(toInstagramPlainText(s)).toBe(s);
    });

    it.each(["2 * 3 = 6", "₹7,000 × 1"])("arithmetic %j", (s) => {
      expect(toInstagramPlainText(s)).toBe(s);
    });

    it.each(["5* hotel", "a_b"])("unpaired marker %j", (s) => {
      expect(toInstagramPlainText(s)).toBe(s);
    });

    it.each(["*bold\nacross lines*", "_open\nclose_"])("markers split by a newline %j", (s) => {
      expect(toInstagramPlainText(s)).toBe(s);
    });
  });

  describe("markers wrapping a URL or email are stripped; the URL itself is not", () => {
    it("bold URL", () => {
      expect(toInstagramPlainText("*https://x.com*")).toBe("https://x.com");
    });

    it("italic URL keeps the underscore inside it", () => {
      expect(toInstagramPlainText("_https://g.page/r/abc_def_")).toBe("https://g.page/r/abc_def");
    });

    it("punctuation after the closing marker stays after the URL", () => {
      expect(toInstagramPlainText("Review us: *https://x.com/a_b*!")).toBe("Review us: https://x.com/a_b!");
    });

    it("a trailing underscore with no opener before the URL is part of the URL", () => {
      expect(toInstagramPlainText("https://x.com/a_b_")).toBe("https://x.com/a_b_");
    });

    it("bold and italic emails", () => {
      expect(toInstagramPlainText("*mail@x.com*")).toBe("mail@x.com");
      expect(toInstagramPlainText("_mail@x.com_")).toBe("mail@x.com");
    });

    it("nested markers around a URL unwrap innermost first", () => {
      expect(toInstagramPlainText("_*https://x.com/a_b*_")).toBe("https://x.com/a_b");
    });

    it("a trailing marker that does not close the opener is left in the URL", () => {
      expect(toInstagramPlainText("*https://x.com_")).toBe("*https://x.com_");
    });
  });

  it("preserves surrounding whitespace and blank lines exactly", () => {
    expect(toInstagramPlainText("  *a*  \n\n\t_b_ ")).toBe("  a  \n\n\tb ");
  });

  it("empty string", () => {
    expect(toInstagramPlainText("")).toBe("");
  });

  it.each(CASES)("is idempotent: f(f(x)) === f(x) for %j", (input, expected) => {
    const once = toInstagramPlainText(input);
    expect(once).toBe(expected);
    expect(toInstagramPlainText(once)).toBe(once);
  });
});
