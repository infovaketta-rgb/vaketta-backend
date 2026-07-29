import { describe, it, expect } from "vitest";
import { splitInstagramMessage } from "./instagramMessageSplitter";

function reflow(chunks: string[]): string {
  // Mirrors how the splitter trims boundaries: rejoin with a single space so
  // we can assert no word/character content was lost or duplicated.
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function totalNonSpaceChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

describe("splitInstagramMessage", () => {
  it("returns the text unchanged when under the limit", () => {
    const text = "See you at check-in!";
    expect(splitInstagramMessage(text)).toEqual([text]);
  });

  it("returns a single chunk for exactly 950 chars", () => {
    const text = "a".repeat(950);
    const chunks = splitInstagramMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("splits 951 chars into two chunks, each within the limit", () => {
    const text = "a".repeat(951);
    const chunks = splitInstagramMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(950);
    expect(totalNonSpaceChars(chunks.join(""))).toBe(951);
  });

  it("splits a 1200-char message into multiple chunks within the cap", () => {
    const text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(21); // ~1218 chars
    const chunks = splitInstagramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(950);
  });

  it("splits a 3000+ char message into multiple chunks, none exceeding the limit", () => {
    const text = "word ".repeat(700); // 3500 chars
    const chunks = splitInstagramMessage(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(950);
  });

  it("prefers splitting at a paragraph boundary (\\n\\n) when available", () => {
    const para1 = "A".repeat(500);
    const para2 = "B".repeat(500);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitInstagramMessage(text, 600);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("falls back to a single newline when no paragraph break exists", () => {
    const line1 = "A".repeat(500);
    const line2 = "B".repeat(500);
    const text = `${line1}\n${line2}`;
    const chunks = splitInstagramMessage(text, 600);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("falls back to a space when no newlines exist", () => {
    const word1 = "A".repeat(500);
    const word2 = "B".repeat(500);
    const text = `${word1} ${word2}`;
    const chunks = splitInstagramMessage(text, 600);
    expect(chunks[0]).toBe(word1);
    expect(chunks[1]).toBe(word2);
  });

  it("hard-splits a long word with no spaces, newlines, or breaks", () => {
    const text = "x".repeat(2000);
    const chunks = splitInstagramMessage(text, 950);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(950);
    expect(chunks[1]!.length).toBe(950);
    expect(chunks[2]!.length).toBe(100);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves paragraphs across a realistic multi-paragraph message", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(5)}`,
    );
    const text = paragraphs.join("\n\n");
    const chunks = splitInstagramMessage(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(950);
    // No content lost: every paragraph's distinguishing marker survives somewhere.
    for (let i = 0; i < paragraphs.length; i++) {
      expect(chunks.some((c) => c.includes(`Paragraph ${i}:`))).toBe(true);
    }
  });

  it("handles emoji without breaking multi-byte characters", () => {
    const text = "🎉".repeat(1200);
    const chunks = splitInstagramMessage(text, 950);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(950);
  });

  it("preserves markdown formatting characters across chunks", () => {
    const text = ("**Bold heading**\n\n" + "- item one\n- item two\n- item three\n\n".repeat(40)).trim();
    const chunks = splitInstagramMessage(text);
    expect(chunks.join("")).not.toContain("undefined");
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(950);
    // Markdown markers survive somewhere in the output.
    expect(chunks.some((c) => c.includes("**Bold heading**"))).toBe(true);
    expect(chunks.join(" ")).toContain("- item one");
  });

  it("never loses or duplicates characters across chunks (round-trip on non-whitespace)", () => {
    const text = ("The quick brown fox jumps over the lazy dog. ".repeat(50) +
      "\n\n" +
      "Second section with more content to push well past the limit. ".repeat(30)).trim();
    const chunks = splitInstagramMessage(text);
    const rejoined = reflow(chunks);
    const expected = text.replace(/\s+/g, " ").trim();
    expect(totalNonSpaceChars(rejoined)).toBe(totalNonSpaceChars(expected));
    expect(rejoined.replace(/\s/g, "")).toBe(expected.replace(/\s/g, ""));
  });

  it("trims whitespace at chunk boundaries", () => {
    const text = "A".repeat(500) + "   \n\n   " + "B".repeat(500);
    const chunks = splitInstagramMessage(text, 600);
    for (const c of chunks) {
      expect(c).toBe(c.trim());
    }
  });
});
