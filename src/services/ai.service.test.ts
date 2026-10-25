/**
 * Tests for the child-age extraction call's token budget.
 *
 * Contract locked in here:
 *  - max_tokens for this call is PER-CALL and derived from childrenCount
 *    (min(400, 24 + n*4)); the shared MAX_TOKENS used by conversational
 *    replies is a different number and is not involved.
 *  - The computed budget actually reaches the provider call — a budget that is
 *    right in a pure function and wrong on the wire fixes nothing.
 *  - A response that stopped at the token limit returns NULL and logs at error.
 *    It must never return the ages that happened to fit: the caller cannot tell
 *    a short array from a complete one, which is exactly how the old flat 40
 *    stayed invisible. This is asserted with a response whose JSON parses
 *    cleanly, so only the stop reason distinguishes it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const anthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...a: any[]) => anthropicCreate(...a) };
  },
}));

const openaiCreate = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: (...a: any[]) => openaiCreate(...a) } };
  },
}));

const logError = vi.fn();
const logWarn  = vi.fn();
vi.mock("../utils/logger", () => ({
  logger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: (...a: any[]) => logWarn(...a), error: (...a: any[]) => logError(...a) }),
  },
}));

// Import-chain stubs — this suite never touches the DB, Redis or availability.
vi.mock("../db/connect", () => ({ default: {} }));
vi.mock("../queue/redis", () => ({ redis: {} }));
vi.mock("./availability.service", () => ({ getCalendarData: vi.fn() }));

import { extractChildrenAgesAI, ageExtractionMaxTokens } from "./ai.service";

/** An Anthropic reply that finished normally. */
const anthropicOk = (text: string) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
});

/** An Anthropic reply cut off at the token limit. */
const anthropicTruncated = (text: string) => ({
  content: [{ type: "text", text }],
  stop_reason: "max_tokens",
});

describe("ageExtractionMaxTokens", () => {
  it("AB1: scales with childrenCount — min(400, 24 + n*4)", () => {
    expect(ageExtractionMaxTokens(2)).toBe(32);
    expect(ageExtractionMaxTokens(12)).toBe(72);
    expect(ageExtractionMaxTokens(23)).toBe(116);
    expect(ageExtractionMaxTokens(40)).toBe(184);
  });

  it("AB2: clamped at 400 for a large count, and not a cap on party size", () => {
    expect(ageExtractionMaxTokens(94)).toBe(400);    // saturation point
    expect(ageExtractionMaxTokens(500)).toBe(400);   // clamped, still answered
    expect(ageExtractionMaxTokens(1e9)).toBe(400);
  });

  it("AB3: no/invalid count → the historical 40, unchanged for one-arg callers", () => {
    expect(ageExtractionMaxTokens()).toBe(40);
    expect(ageExtractionMaxTokens(0)).toBe(40);
    expect(ageExtractionMaxTokens(-3)).toBe(40);
    expect(ageExtractionMaxTokens(NaN)).toBe(40);
  });
});

describe("extractChildrenAgesAI token budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("AI_PROVIDER", "anthropic");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("AB4: sends the computed budget as max_tokens for 2 / 12 / 23 / 40 children", async () => {
    for (const [count, expected] of [[2, 32], [12, 72], [23, 116], [40, 184]] as const) {
      anthropicCreate.mockResolvedValueOnce(anthropicOk('{"ages":[5]}'));
      await extractChildrenAgesAI("all 5", count);
      expect(anthropicCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({ max_tokens: expected }),
      );
    }
  });

  it("AB5: a complete response still returns the ages", async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicOk('{"ages":[5,5,5]}'));
    expect(await extractChildrenAgesAI("all 5", 3)).toEqual([5, 5, 5]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("AB6: truncated response → null, never the partial array", async () => {
    // Deliberately VALID json holding too few ages: only stop_reason marks it.
    anthropicCreate.mockResolvedValueOnce(anthropicTruncated('{"ages":[5,5,5]}'));
    const result = await extractChildrenAgesAI("all 5", 23);
    expect(result).toBeNull();
    expect(result).not.toEqual([5, 5, 5]);
  });

  it("AB7: truncation logs at error with childrenCount and maxTokens", async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicTruncated('{"ages":[5,5,5,5,5'));
    await extractChildrenAgesAI("all 5", 23);
    expect(logError).toHaveBeenCalledTimes(1);
    const [fields, message] = logError.mock.calls[0]!;
    expect(fields).toMatchObject({ childrenCount: 23, maxTokens: 116 });
    expect(fields.err).toBeInstanceOf(Error);
    expect(message).toMatch(/truncated/i);
  });

  it("AB8: openai branch — finish_reason 'length' is truncation too", async () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ages":[5,5]}' }, finish_reason: "length" }],
    });
    const result = await extractChildrenAgesAI("all 5", 12);
    expect(openaiCreate).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 72 }));
    expect(result).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("AB10: the count is framed as context, never as a required length", async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicOk('{"ages":[5]}'));
    await extractChildrenAgesAI("my kids are 5 and 8", 3);
    const { system } = anthropicCreate.mock.calls[0]![0];
    // The quota wording is what invited padding — it must not come back.
    expect(system).not.toMatch(/return exactly \d+ ages/i);
    expect(system).toMatch(/NOT a required length/i);
    expect(system).toMatch(/never invent, infer, guess, duplicate or pad/i);
    expect(system).toMatch(/return the shorter array/i);
  });

  it("AB11: collective expansion and the count-is-not-an-age rule survive", async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicOk('{"ages":[5,5,5]}'));
    await extractChildrenAgesAI("all 5", 3);
    const { system } = anthropicCreate.mock.calls[0]![0];
    expect(system).toMatch(/expand it to 3 ages/i);
    expect(system).toMatch(/is a COUNT,\s*not an age/i);
  });

  it("AB12: no count → no count-specific clauses in the prompt at all", async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicOk('{"ages":[8,8]}'));
    await extractChildrenAgesAI("the twins are 8");
    const { system } = anthropicCreate.mock.calls[0]![0];
    expect(system).not.toMatch(/required length|shorter array|The guest has/i);
    expect(system).toMatch(/twins/i);   // relative-phrasing rule still there
  });

  it("AB9: openai branch — finish_reason 'stop' returns the ages", async () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ages":[5,8]}' }, finish_reason: "stop" }],
    });
    expect(await extractChildrenAgesAI("kids are 5 and 8", 2)).toEqual([5, 8]);
    expect(logError).not.toHaveBeenCalled();
  });
});
