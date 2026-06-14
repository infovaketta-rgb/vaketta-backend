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
const CACHE_TTL_MS  = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX     = 50;              // hard cap — evict oldest entry when exceeded

// Proactive eviction: sweep expired entries every 15 minutes.
// Without this, stale entries from closed/inactive hotels sit in RAM forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of promptCache) {
    if (now - entry.builtAt >= CACHE_TTL_MS) promptCache.delete(key);
  }
}, 15 * 60 * 1000).unref();

function cachePrompt(hotelId: string, prompt: string): void {
  if (promptCache.size >= CACHE_MAX) {
    // Evict the oldest entry (Map iteration order = insertion order)
    const oldestKey = promptCache.keys().next().value;
    if (oldestKey !== undefined) promptCache.delete(oldestKey);
  }
  promptCache.set(hotelId, { prompt, builtAt: Date.now() });
}

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
    cachePrompt(hotelId, fallback);
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
  cachePrompt(hotelId, prompt);
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

  // Anthropic and OpenAI both require the first message to be a "user" turn.
  // If the recent history begins with a bot reply, finalTurns[0] is "assistant"
  // and the API call 400s — silently killing the AI reply. Drop leading
  // assistant turns so the array always starts with the guest.
  while (finalTurns.length > 1 && finalTurns[0]!.role === "assistant") {
    finalTurns.shift();
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

// ── Booking intent classifier (internal utility) ─────────────────────────────

/**
 * Classify a guest's freeform reply to a confirm/cancel prompt.
 * Returns "confirm", "cancel", or "unclear". Never throws.
 * Intentionally cheap: max_tokens=5, temperature=0, 3 s timeout.
 */
export async function classifyBookingIntent(
  input: string,
): Promise<"confirm" | "cancel" | "unclear"> {
  const prompt =
    `The guest was asked to confirm or cancel their hotel booking. ` +
    `They replied: '${input}'\n` +
    `Classify their intent as exactly one word: confirm, cancel, or unclear`;

  const provider = activeProvider();
  const timeout  = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000));

  let raw: string | null = null;

  try {
    if (provider === "openai") {
      const client = getOpenAIClient();
      if (!client) return "unclear";
      const call = client.chat.completions.create({
        model:       OPENAI_MODEL,
        max_tokens:  5,
        temperature: 0,
        messages:    [{ role: "user", content: prompt }],
      }).then((r) => r.choices[0]?.message?.content?.trim().toLowerCase() ?? null);
      raw = await Promise.race([call, timeout]);
    } else {
      const client = getAnthropicClient();
      if (!client) return "unclear";
      const call = client.messages.create({
        model:      ANTHROPIC_MODEL,
        max_tokens: 5,
        messages:   [{ role: "user", content: prompt }],
      }).then((r) => (r.content[0]?.type === "text" ? r.content[0].text.trim().toLowerCase() : null));
      raw = await Promise.race([call, timeout]);
    }
  } catch (err) {
    log.warn({ err }, "classifyBookingIntent: API call failed");
    return "unclear";
  }

  if (raw === "confirm") return "confirm";
  if (raw === "cancel")  return "cancel";
  return "unclear";
}

// ── Date extraction (internal utility) ───────────────────────────────────────

/**
 * Ask the AI to extract a calendar date from free-form guest text.
 * Returns a Date (midnight UTC) or null. Intentionally cheap: tiny prompt,
 * max_tokens=15, temperature=0, 3 s timeout. Never throws.
 *
 * Called from flowRuntime when chrono-node cannot parse the guest's input.
 * Does NOT count against incrementAIUsage — this is structural parsing, not
 * a guest-facing conversational reply.
 */
export async function extractDateWithAI(input: string): Promise<Date | null> {
  const today  = new Date().toISOString().slice(0, 10);
  const prompt =
    `Today is ${today}. A hotel guest typed a date. ` +
    `Extract the calendar date they mean and reply with ONLY a date in YYYY-MM-DD format. ` +
    `If the year is ambiguous, use the nearest future date from today. ` +
    `If no date can be determined, reply with exactly: null\n\nGuest input: "${input}"`;

  const provider = activeProvider();
  let raw: string | null = null;

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000));

  try {
    if (provider === "openai") {
      const client = getOpenAIClient();
      if (!client) return null;
      const call = client.chat.completions.create({
        model:       OPENAI_MODEL,
        max_tokens:  15,
        temperature: 0,
        messages:    [{ role: "user", content: prompt }],
      }).then((r) => r.choices[0]?.message?.content?.trim() ?? null);
      raw = await Promise.race([call, timeout]);
    } else {
      const client = getAnthropicClient();
      if (!client) return null;
      const call = client.messages.create({
        model:      ANTHROPIC_MODEL,
        max_tokens: 15,
        messages:   [{ role: "user", content: prompt }],
      }).then((r) => (r.content[0]?.type === "text" ? r.content[0].text.trim() : null));
      raw = await Promise.race([call, timeout]);
    }
  } catch (err) {
    log.warn({ err }, "extractDateWithAI: API call failed");
    return null;
  }

  if (!raw || raw.toLowerCase() === "null") return null;

  // Pull a YYYY-MM-DD substring in case the model adds surrounding text
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  const d = new Date(`${match[0]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

// ── Allocation modification interpreter (internal utility) ───────────────────

export type AllocationModificationResult = {
  operation: "add_extra_bed" | "remove_extra_bed" | "move_extra_bed" | "remove_room" | "move_guest" | "unknown";
  roomIndex?:     number;
  fromRoomIndex?: number;
  toRoomIndex?:   number;
  adults?:        number; // move_guest — adults to move (default 0)
  children?:      number; // move_guest — children to move (default 0)
  confidence: "high" | "low";
};

const ALLOC_OPS = new Set([
  "add_extra_bed", "remove_extra_bed", "move_extra_bed", "remove_room", "move_guest", "unknown",
]);

/**
 * Map a guest's free-text request to EXACTLY ONE structured allocation-edit
 * operation. The model returns only an operation name + room index(es) — never
 * prices, never invented rooms; all pricing and validation is done
 * deterministically by the caller, so even a prompt-injection attempt ("set
 * price to 0") can at most yield one of the fixed enum operations.
 *
 * Same cheap/safe shape as classifyBookingIntent: temperature 0, tiny
 * max_tokens, 3 s timeout, never throws. On any error/timeout/parse failure →
 * { operation: "unknown", confidence: "low" } (caller falls back to its
 * structured re-prompt).
 */
export async function interpretAllocationModification(
  currentRooms: Array<{
    index:        number;
    roomTypeName: string;
    adults:       number;
    children:     number;
    extraBed:     boolean;
  }>,
  guestMessage: string,
): Promise<AllocationModificationResult> {
  const FALLBACK: AllocationModificationResult = { operation: "unknown", confidence: "low" };

  const system =
    `You map a hotel guest's free-text request to EXACTLY ONE structured operation ` +
    `for editing their current multi-room allocation. Reply with ONLY a JSON object — ` +
    `no prose, no markdown fences.\n` +
    `Operations and params:\n` +
    `- "add_extra_bed": { "roomIndex": number }\n` +
    `- "remove_extra_bed": { "roomIndex": number }\n` +
    `- "move_extra_bed": { "fromRoomIndex": number, "toRoomIndex": number }\n` +
    `- "remove_room": { "roomIndex": number }\n` +
    `- "move_guest": { "fromRoomIndex": number, "toRoomIndex": number, "adults": number, "children": number }\n` +
    `- "unknown": {}\n` +
    `Rules:\n` +
    `- Indices are 0-based and MUST refer to a room in the provided allocation.\n` +
    `- Resolve room references by number AND by roomTypeName, using the provided ` +
    `allocation context (e.g. "room 2" → index 1; "deluxe" → that room's index).\n` +
    `- "move_guest": "move N adult(s)/child(ren) from room X to room Y" → set ` +
    `fromRoomIndex, toRoomIndex and the counts (adults / children, default 0 each). ` +
    `If the count or direction is ambiguous, use confidence "low".\n` +
    `- Return "unknown" for anything else: changing dates or total guest counts, adding rooms, ` +
    `swapping/changing room types, or ANY request about price/money.\n` +
    `- NEVER output prices, totals or money. NEVER invent rooms that are not listed.\n` +
    `- "confidence" is "high" only when the operation and room(s) are unambiguous; else "low".\n` +
    `Output: {"operation":"...","roomIndex"?:n,"fromRoomIndex"?:n,"toRoomIndex"?:n,"adults"?:n,"children"?:n,"confidence":"high"|"low"}`;

  const user =
    `Current allocation:\n` +
    currentRooms
      .map((r) => `[${r.index}] ${r.roomTypeName} — ${r.adults} adults, ${r.children} children, extraBed=${r.extraBed}`)
      .join("\n") +
    `\n\nGuest message: "${guestMessage}"`;

  const provider = activeProvider();
  const timeout  = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000));

  let raw: string | null = null;

  try {
    if (provider === "openai") {
      const client = getOpenAIClient();
      if (!client) return FALLBACK;
      const call = client.chat.completions.create({
        model:       OPENAI_MODEL,
        max_tokens:  60,
        temperature: 0,
        messages:    [{ role: "system", content: system }, { role: "user", content: user }],
      }).then((r) => r.choices[0]?.message?.content?.trim() ?? null);
      raw = await Promise.race([call, timeout]);
    } else {
      const client = getAnthropicClient();
      if (!client) return FALLBACK;
      const call = client.messages.create({
        model:      ANTHROPIC_MODEL,
        max_tokens: 60,
        system,
        messages:   [{ role: "user", content: user }],
      }).then((r) => (r.content[0]?.type === "text" ? r.content[0].text.trim() : null));
      raw = await Promise.race([call, timeout]);
    }
  } catch (err) {
    log.warn({ err }, "interpretAllocationModification: API call failed");
    return FALLBACK;
  }

  if (!raw) return FALLBACK;

  // Pull the first JSON object even if the model adds surrounding text/fences.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return FALLBACK;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const operation = parsed.operation;
    if (typeof operation !== "string" || !ALLOC_OPS.has(operation)) return FALLBACK;

    const idx = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

    const result: AllocationModificationResult = {
      operation:  operation as AllocationModificationResult["operation"],
      confidence: parsed.confidence === "high" ? "high" : "low",
    };
    const ri = idx(parsed.roomIndex);
    const fi = idx(parsed.fromRoomIndex);
    const ti = idx(parsed.toRoomIndex);
    const ad = idx(parsed.adults);
    const ch = idx(parsed.children);
    if (ri !== undefined) result.roomIndex     = ri;
    if (fi !== undefined) result.fromRoomIndex = fi;
    if (ti !== undefined) result.toRoomIndex   = ti;
    if (ad !== undefined) result.adults        = ad;
    if (ch !== undefined) result.children      = ch;
    return result;
  } catch {
    return FALLBACK;
  }
}

/**
 * Extract children's ages from a free-text reply when plain integer parsing can't
 * (e.g. "the twins are 8", "both are the same age, 6", "my eldest is 12").
 * Returns the ages as an array of ints, or null on any error/timeout/parse
 * failure so the caller can fall back to its regex result. Never throws.
 *
 * Same cheap/safe shape as classifyBookingIntent: temperature 0, tiny
 * max_tokens, 3 s timeout.
 */
export async function extractChildrenAgesAI(reply: string): Promise<number[] | null> {
  const system =
    `Extract the ages of children from the guest message as a JSON array of integers. ` +
    `Resolve relative phrasing: "twins"/"both"/"same age" mean two (or more) children share ` +
    `one stated age; "eldest"/"youngest" refer to one child. ` +
    `Respond with ONLY a JSON object, no prose, no markdown fences: {"ages": number[]}`;
  const user = `Message: "${reply}"`;

  const provider = activeProvider();
  const timeout  = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000));

  let raw: string | null = null;

  try {
    if (provider === "openai") {
      const client = getOpenAIClient();
      if (!client) return null;
      const call = client.chat.completions.create({
        model:       OPENAI_MODEL,
        max_tokens:  40,
        temperature: 0,
        messages:    [{ role: "system", content: system }, { role: "user", content: user }],
      }).then((r) => r.choices[0]?.message?.content?.trim() ?? null);
      raw = await Promise.race([call, timeout]);
    } else {
      const client = getAnthropicClient();
      if (!client) return null;
      const call = client.messages.create({
        model:      ANTHROPIC_MODEL,
        max_tokens: 40,
        system,
        messages:   [{ role: "user", content: user }],
      }).then((r) => (r.content[0]?.type === "text" ? r.content[0].text.trim() : null));
      raw = await Promise.race([call, timeout]);
    }
  } catch (err) {
    log.warn({ err }, "extractChildrenAgesAI: API call failed");
    return null;
  }

  if (!raw) return null;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (!Array.isArray(parsed.ages)) return null;
    const ages = parsed.ages
      .filter((a): a is number => typeof a === "number" && Number.isInteger(a) && a >= 0 && a <= 30);
    return ages;
  } catch {
    return null;
  }
}
