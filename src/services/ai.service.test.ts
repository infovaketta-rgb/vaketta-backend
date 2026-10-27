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

// Import-chain stubs. Only the system-prompt suite reads the DB (hotel row +
// empty history); Redis is a bare object, so the AI rate limit fails open.
const hotelFindUnique = vi.fn();
const messageFindMany = vi.fn();
vi.mock("../db/connect", () => ({
  default: {
    hotel:   { findUnique: (...a: any[]) => hotelFindUnique(...a) },
    message: { findMany:   (...a: any[]) => messageFindMany(...a) },
  },
}));
vi.mock("../queue/redis", () => ({ redis: {} }));
vi.mock("./availability.service", () => ({ getCalendarData: vi.fn() }));

import { MessageChannel } from "@prisma/client";
import {
  extractChildrenAgesAI,
  ageExtractionMaxTokens,
  getSystemPrompt,
  getAIReply,
  invalidatePromptCache,
} from "./ai.service";
import { toInstagramPlainText } from "./instagramFormat";

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

// ── Channel-aware system prompt + per-channel prompt cache ───────────────────
// The prompt used to open "You are the WhatsApp assistant for *Hotel*" and ask
// for WhatsApp markdown on every channel, so Instagram guests were told they
// were talking to a WhatsApp bot and got literal asterisks.

describe("channel-aware system prompt", () => {
  const HOTEL_ROW = {
    name:         "Maadathil Cottages & Beach Resort",
    description:  "Beachfront cottages",
    location:     "Varkala, Kerala",
    website:      "https://maadathil.example/stay_here",
    email:        "stay@maadathil.example",
    checkInTime:  "14:00",
    checkOutTime: "11:00",
    config: { businessStartHour: 9, businessEndHour: 21, timezone: "Asia/Kolkata", aiInstructions: "Mention free parking." },
    roomTypes: [{ name: "Deluxe Cottage", basePrice: 5000, capacity: 3, maxAdults: 2, maxChildren: 1, description: "Sea view" }],
    menu: { items: [{ key: "1", label: "Book a room" }, { key: "2", label: "Talk to staff" }] },
  };
  const WA_RULE = "- Use WhatsApp formatting (*bold*, _italic_) only for key facts — do not overuse.";
  const IG_RULE = "- Plain text only. Do not use *, _, ~ or ` for formatting. Emoji and line breaks are fine.";
  const { WHATSAPP, INSTAGRAM } = MessageChannel;

  // The cache is module-level, so every test uses its own hotel ids.
  let n = 0;
  const hotelId = () => `hotel_prompt_${++n}`;

  beforeEach(() => {
    hotelFindUnique.mockReset().mockResolvedValue(HOTEL_ROW);
    messageFindMany.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("CP1: INSTAGRAM and WHATSAPP prompts differ only in the formatting rule", async () => {
    const id = hotelId();
    const wa = (await getSystemPrompt(id, WHATSAPP)).split("\n");
    const ig = (await getSystemPrompt(id, INSTAGRAM)).split("\n");
    expect(ig.length).toBe(wa.length);
    const diff = wa.map((_, i) => i).filter((i) => wa[i] !== ig[i]);
    expect(diff).toHaveLength(1);
    expect(wa[diff[0]!]).toBe(WA_RULE);
    expect(ig[diff[0]!]).toBe(IG_RULE);
  });

  it("CP2: neither prompt says 'WhatsApp' outside the WhatsApp formatting rule; identity is neutral and unstarred", async () => {
    const id = hotelId();
    for (const channel of [WHATSAPP, INSTAGRAM]) {
      const p = await getSystemPrompt(id, channel);
      expect(p.replace(WA_RULE, "")).not.toMatch(/whatsapp/i);
      expect(p).toContain("You are the virtual assistant for Maadathil Cottages & Beach Resort, located in Varkala, Kerala.");
      expect(p).not.toContain("*Maadathil");
      expect(p).toContain("If a guest asks who or what you are, say you are the hotel's virtual assistant. Never name a messaging platform.");
      // Prompt wording carries no markdown of its own.
      expect(p).toContain("  • Reply 1 for Book a room");
      expect(p).toContain("- Always end by reminding the guest: reply MENU to see all options.");
    }
  });

  it("CP3: the INSTAGRAM prompt contains no paired markdown", async () => {
    const p = await getSystemPrompt(hotelId(), INSTAGRAM);
    expect(toInstagramPlainText(p)).toBe(p);
  });

  it("CP4: WHATSAPP then INSTAGRAM within the TTL rebuilds instead of reusing; same channel is cached", async () => {
    const id = hotelId();
    await getSystemPrompt(id, WHATSAPP);
    await getSystemPrompt(id, WHATSAPP);
    expect(hotelFindUnique).toHaveBeenCalledTimes(1);

    const ig = await getSystemPrompt(id, INSTAGRAM);
    expect(hotelFindUnique).toHaveBeenCalledTimes(2);
    expect(ig).toContain(IG_RULE);
    expect(ig).not.toContain(WA_RULE);
  });

  it("CP5: invalidatePromptCache clears every channel of that hotel and leaves other hotels alone", async () => {
    const a = hotelId();
    const b = hotelId();
    await getSystemPrompt(a, WHATSAPP);
    await getSystemPrompt(a, INSTAGRAM);
    await getSystemPrompt(b, WHATSAPP);
    expect(hotelFindUnique).toHaveBeenCalledTimes(3);

    invalidatePromptCache(a);

    await getSystemPrompt(a, WHATSAPP);
    await getSystemPrompt(a, INSTAGRAM);
    await getSystemPrompt(b, WHATSAPP);
    expect(hotelFindUnique).toHaveBeenCalledTimes(5); // a rebuilt twice, b still cached
    const rebuiltFor = hotelFindUnique.mock.calls.slice(3).map((c) => c[0].where.id);
    expect(rebuiltFor).toEqual([a, a]);
  });

  it("CP6: no channel argument behaves as WHATSAPP and shares its cache entry", async () => {
    const id = hotelId();
    const implicit = await getSystemPrompt(id);
    const explicit = await getSystemPrompt(id, WHATSAPP);
    expect(implicit).toBe(explicit);
    expect(implicit).toContain(WA_RULE);
    expect(hotelFindUnique).toHaveBeenCalledTimes(1);
  });

  it("CP7: getAIReply sends the channel's prompt to the provider; default is WHATSAPP", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("AI_PROVIDER", "anthropic");
    anthropicCreate.mockReset().mockResolvedValue(anthropicOk("Yes, parking is free."));
    const id = hotelId();
    const systemText = (call: number) => anthropicCreate.mock.calls[call]![0].system[0].text as string;

    await getAIReply(id, "guest_1", "Is parking free?", INSTAGRAM);
    expect(systemText(0)).toContain(IG_RULE);
    expect(systemText(0)).not.toMatch(/whatsapp/i);

    await getAIReply(id, "guest_1", "Is parking free?");
    expect(systemText(1)).toContain(WA_RULE);
  });
});
