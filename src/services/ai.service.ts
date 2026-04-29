/**
 * ai.service.ts
 *
 * AI reply worker for Vaketta — invoked as a last-resort fallback after the
 * menu/flow engine has already run and found no matching intent.
 *
 * Call order enforced by botEngine:
 *   1. Menu key match?      → return menu response     (skip AI)
 *   2. Active flow match?   → return flow response     (skip AI)
 *   3. No match found       → call getAIReply()        (this file)
 *
 * Provider switching:
 *   Set AI_PROVIDER=anthropic (default) or AI_PROVIDER=openai in .env.
 *   Both providers use the same 3-layer prompt structure and return the same
 *   { text, handoff } shape — callers never see which provider is active.
 *
 * Prompt layers assembled on every call:
 *   1. CACHED system prompt  — static hotel identity, room data, and behaviour
 *                              rules; marked with cache_control (Anthropic) so
 *                              Claude caches the prefix. Rebuilt from DB at most
 *                              once per 10 min per hotel via in-memory TTL cache.
 *   2. DYNAMIC context       — live 30-day room availability; injected only when
 *                              the guest message contains availability-related
 *                              keywords. Never cached (changes per request).
 *   3. Conversation history  — last 6 messages, deduplicated to satisfy strict
 *                              user/assistant alternation requirements.
 *   4. User message          — the raw unmatched guest input.
 *
 * Return value: { text, handoff } | null
 *   text     — the reply to send to the guest ([HANDOFF_REQUIRED] token stripped)
 *   handoff  — true when the model detected an angry/sensitive guest; botEngine
 *              will transition session to ENQUIRY_OPEN and silence further replies.
 *
 * Usage tracking: incrementAIUsage() is called in botEngine, not here, so that
 * only successful AI replies are counted — never bot rule matches.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI    from "openai";
import prisma    from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import { getCalendarData } from "./availability.service";

const log = logger.child({ service: "ai" });

// ── Provider selection ────────────────────────────────────────────────────────

type Provider = "anthropic" | "openai";

function activeProvider(): Provider {
  const p = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  if (p === "openai") return "openai";
  return "anthropic";
}

// Lazy-initialised clients — only created when a key is present
let _anthropic: Anthropic | null = null;
let _openai:    OpenAI    | null = null;

function getAnthropicClient(): Anthropic | null {
  if (!_anthropic && process.env.ANTHROPIC_API_KEY) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

function getOpenAIClient(): OpenAI | null {
  if (!_openai && process.env.OPENAI_API_KEY) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// Model constants per provider
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_MODEL    = "gpt-4o-mini";
const MAX_TOKENS      = 260;
const HISTORY_LEN     = 6;

// ── Per-guest AI rate limit ───────────────────────────────────────────────────

const AI_RATE_LIMIT_MAX  = 5;   // max AI calls per guest
const AI_RATE_LIMIT_SECS = 60;  // within this window (seconds)

async function checkAIRateLimit(hotelId: string, guestId: string): Promise<boolean> {
  try {
    const key = `ai:rl:${hotelId}:${guestId}`;
    const results = await redis.pipeline().incr(key).expire(key, AI_RATE_LIMIT_SECS).exec();
    const count = (results?.[0]?.[1] as number) ?? 0;
    return count <= AI_RATE_LIMIT_MAX;
  } catch {
    return true; // fail open — never block AI if Redis is unavailable
  }
}

// ── Layer 1: Cached system prompt ─────────────────────────────────────────────

type CacheEntry = { prompt: string; builtAt: number };
const promptCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getSystemPrompt(hotelId: string): Promise<string> {
  const cached = promptCache.get(hotelId);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached.prompt;

  const hotel = await prisma.hotel.findUnique({
    where:  { id: hotelId },
    select: {
      name:         true,
      description:  true,
      location:     true,
      website:      true,
      email:        true,
      checkInTime:  true,
      checkOutTime: true,
      config: {
        select: {
          businessStartHour: true,
          businessEndHour:   true,
          timezone:          true,
          aiInstructions:    true,
        },
      },
      roomTypes: {
        select: {
          name:        true,
          basePrice:   true,
          capacity:    true,
          maxAdults:   true,
          maxChildren: true,
          description: true,
        },
      },
      menu: {
        include: {
          items: {
            where:   { isActive: true },
            orderBy: { order: "asc" },
            select:  { key: true, label: true },
          },
        },
      },
    },
  });

  if (!hotel) {
    const fallback = "You are a hotel assistant. Answer guest questions helpfully and briefly.";
    promptCache.set(hotelId, { prompt: fallback, builtAt: Date.now() });
    return fallback;
  }

  const cfg = hotel.config;

  const roomLines = hotel.roomTypes.map((r) => {
    const guests = r.maxAdults
      ? `${r.maxAdults} adults${r.maxChildren ? ` + ${r.maxChildren} children` : ""}`
      : r.capacity
      ? `${r.capacity} guests`
      : "";
    const parts = [
      `₹${r.basePrice.toLocaleString("en-IN")}/night`,
      guests,
      r.description,
    ].filter(Boolean);
    return `  • ${r.name}: ${parts.join(" · ")}`;
  });

  const menuLines =
    hotel.menu?.items.map((i) => `  • Reply *${i.key}* for ${i.label}`) ?? [];

  const lines: string[] = [
    `You are the WhatsApp assistant for *${hotel.name}*${hotel.location ? `, located in ${hotel.location}` : ""}.`,
    `You answer guest questions on behalf of the hotel.`,
    ``,
    `## Rules`,
    `- Reply in the same language the guest uses. Auto-detect — never ask.`,
    `- Keep replies to 1–3 sentences unless the guest explicitly asks for detail.`,
    `- NEVER confirm a booking directly. Say "our team will confirm your reservation shortly."`,
    `- NEVER quote a price not listed in the hotel data below.`,
    `- If unsure about any fact, say "Let me connect you with our team" and nothing more.`,
    `- Use WhatsApp formatting (*bold*, _italic_) only for key facts — do not overuse.`,
    `- Always end by reminding the guest: reply *MENU* to see all options.`,
    `- If a guest expresses anger, frustration, or raises a sensitive complaint, end your reply with the exact token [HANDOFF_REQUIRED] on its own line. Do not explain the token.`,
    ``,
    `## Hotel details`,
    hotel.description ? `Description: ${hotel.description}` : null,
    hotel.location    ? `Location: ${hotel.location}` : null,
    hotel.email       ? `Email: ${hotel.email}` : null,
    hotel.website     ? `Website: ${hotel.website}` : null,
    hotel.checkInTime  ? `Check-in: ${hotel.checkInTime}` : null,
    hotel.checkOutTime ? `Check-out: ${hotel.checkOutTime}` : null,
    cfg?.businessStartHour !== undefined
      ? `Business hours: ${cfg.businessStartHour}:00 – ${cfg.businessEndHour}:00 (${cfg.timezone ?? "local time"})`
      : null,
    ``,
    roomLines.length ? `## Room types\n${roomLines.join("\n")}` : null,
    menuLines.length ? `\n## Menu options\n${menuLines.join("\n")}` : null,
  ].filter((l): l is string => l !== null);

  const aiInstructions = (cfg as any)?.aiInstructions as string | null | undefined;
  if (aiInstructions?.trim()) {
    lines.push(``, `## Custom Instructions`, aiInstructions.trim());
  }

  const prompt = lines.join("\n");
  promptCache.set(hotelId, { prompt, builtAt: Date.now() });
  return prompt;
}

/** Invalidate cached prompt — call when hotel config or room types change. */
export function invalidatePromptCache(hotelId: string): void {
  promptCache.delete(hotelId);
}

// ── Layer 2: Dynamic availability context ─────────────────────────────────────

const AVAILABILITY_KEYWORDS =
  /\b(available|availability|room|rooms|dates?|check.?in|check.?out|book|booking|free|vacant|vacancy|stay|night|nights?)\b/i;

async function buildAvailabilityContext(hotelId: string): Promise<string | null> {
  try {
    const today  = new Date();
    const future = new Date(today.getTime() + 30 * 86_400_000);
    const start  = today.toISOString().slice(0, 10);
    const end    = future.toISOString().slice(0, 10);

    const { roomTypes, dates, cells } = await getCalendarData(hotelId, start, end);
    if (!roomTypes.length) return null;

    const lines: string[] = [`[LIVE AVAILABILITY — as of ${start}]`];

    for (const rt of roomTypes) {
      let minAvail = Infinity;
      let minPrice = rt.basePrice;
      for (const ds of dates) {
        const cell = cells[rt.id]?.[ds];
        if (cell) {
          if (cell.availableRooms < minAvail) minAvail = cell.availableRooms;
          if (cell.price          < minPrice) minPrice  = cell.price;
        }
      }
      const avail = minAvail === Infinity ? rt.totalRooms : minAvail;
      const label = avail === 0
        ? "SOLD OUT"
        : `${avail} room${avail > 1 ? "s" : ""} available from ₹${minPrice.toLocaleString("en-IN")}/night`;
      lines.push(`  • ${rt.name}: ${label}`);
    }
    return lines.join("\n");
  } catch {
    return null; // never block the AI reply on an availability error
  }
}

// ── Message history ───────────────────────────────────────────────────────────

type Turn = { role: "user" | "assistant"; content: string };

async function buildHistory(hotelId: string, guestId: string): Promise<Turn[]> {
  const rows = await prisma.message.findMany({
    where:   { hotelId, guestId },
    orderBy: { timestamp: "desc" },
    take:    HISTORY_LEN,
    select:  { direction: true, body: true },
  });

  const turns: Turn[] = rows
    .reverse()
    .filter((m) => m.body)
    .map((m) => ({
      role:    m.direction === "IN" ? "user" : "assistant",
      content: m.body as string,
    }));

  // Deduplicate consecutive same-role turns (keep the latest of each run)
  const deduped: Turn[] = [];
  for (const t of turns) {
    if (deduped.length > 0 && deduped[deduped.length - 1]!.role === t.role) {
      deduped[deduped.length - 1] = t;
    } else {
      deduped.push(t);
    }
  }
  return deduped;
}

// ── Parse handoff token ───────────────────────────────────────────────────────

const HANDOFF_TOKEN = "[HANDOFF_REQUIRED]";

function parseReply(raw: string): { text: string; handoff: boolean } {
  const handoff = raw.includes(HANDOFF_TOKEN);
  const text    = raw.replace(HANDOFF_TOKEN, "").trim();
  return { text, handoff };
}

// ── Provider implementations ──────────────────────────────────────────────────

async function callAnthropic(
  systemPrompt: string,
  availabilityContext: string | null,
  messages: Turn[],
): Promise<string | null> {
  const client = getAnthropicClient();
  if (!client) {
    log.warn("ANTHROPIC_API_KEY not set");
    return null;
  }

  // Layer 1: cached system prompt
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type:          "text",
      text:          systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  // Layer 2: dynamic availability (not cached)
  if (availabilityContext) {
    systemBlocks.push({
      type: "text",
      text: `\n${availabilityContext}\n\nUse the above data if the guest asks about rooms or dates.`,
    });
  }

  const response = await client.messages.create({
    model:      ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system:     systemBlocks as any,
    messages,
  });

  const block = response.content[0];
  return block?.type === "text" ? block.text.trim() || null : null;
}

async function callOpenAI(
  systemPrompt: string,
  availabilityContext: string | null,
  messages: Turn[],
  userMessage: string,
): Promise<string | null> {
  const client = getOpenAIClient();
  if (!client) {
    log.warn("OPENAI_API_KEY not set");
    return null;
  }

  const fullSystem = availabilityContext
    ? `${systemPrompt}\n\n${availabilityContext}\n\nUse the above data if the guest asks about rooms or dates.`
    : systemPrompt;

  // Build the OpenAI message array: system + history + current user message
  const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystem },
    ...messages.map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
    { role: "user", content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model:       OPENAI_MODEL,
    max_tokens:  MAX_TOKENS,
    temperature: 0.65,
    messages:    oaiMessages,
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type AIReplyResult = { text: string; handoff: boolean };

/**
 * Generate an AI reply for an unmatched guest message.
 *
 * Called ONLY when the menu/flow engine found no match.
 * Returns null when the configured provider has no API key or the call fails.
 */
export async function getAIReply(
  hotelId:     string,
  guestId:     string,
  userMessage: string,
): Promise<AIReplyResult | null> {
  const allowed = await checkAIRateLimit(hotelId, guestId);
  if (!allowed) return null;

  const provider = activeProvider();
  const needsAvailability = AVAILABILITY_KEYWORDS.test(userMessage);

  const [systemPrompt, history, availabilityContext] = await Promise.all([
    getSystemPrompt(hotelId),
    buildHistory(hotelId, guestId),
    needsAvailability ? buildAvailabilityContext(hotelId) : Promise.resolve(null),
  ]);

  // Merge history with the current user message, ensuring final turn is "user"
  const allTurns: Turn[] = [...history, { role: "user", content: userMessage }];
  const finalTurns: Turn[] = [];
  for (const t of allTurns) {
    if (finalTurns.length > 0 && finalTurns[finalTurns.length - 1]!.role === t.role) {
      finalTurns[finalTurns.length - 1] = t;
    } else {
      finalTurns.push(t);
    }
  }

  try {
    let raw: string | null = null;

    if (provider === "openai") {
      raw = await callOpenAI(systemPrompt, availabilityContext, finalTurns.slice(0, -1), userMessage);
    } else {
      raw = await callAnthropic(systemPrompt, availabilityContext, finalTurns);
    }

    if (!raw) return null;
    return parseReply(raw);
  } catch (err: any) {
    log.error({ provider, err: err?.message ?? err }, "AI API error");
    return null;
  }
}
