import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";

const log = logger.child({ service: "session" });

export type SessionData = {
  bookingGuestName?:    string;
  bookingRoomTypeId?:   string;
  bookingRoomTypeName?: string;
  bookingPricePerNight?: number;
  bookingCheckIn?:      string; // YYYY-MM-DD
  bookingCheckOut?:     string; // YYYY-MM-DD
  roomList?: Array<{ id: string; name: string; basePrice: number; capacity: number | null; description: string }>;
  // Flow runner state (present when session.state starts with "FLOW:")
  flow?: {
    flowId:      string;
    flowVars:    Record<string, string>; // variableName → collected answer
    waitingFor?: "answer";
    lastInput?:  string;
  };
};

type SessionRecord = { state: string; data: SessionData };

const SESSION_TTL = 86_400; // 24 hours in seconds
const sessionKey  = (guestId: string, hotelId: string) => `session:${hotelId}:${guestId}`;

// ── Redis helpers ─────────────────────────────────────────────────────────────

async function redisGet(guestId: string, hotelId: string): Promise<SessionRecord | null> {
  try {
    const raw = await redis.get(sessionKey(guestId, hotelId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionRecord;
  } catch (err) {
    log.warn({ err, guestId, hotelId }, "session redis GET failed — falling back to Postgres");
    return null;
  }
}

async function redisSet(guestId: string, hotelId: string, state: string, data: SessionData): Promise<void> {
  try {
    await redis.set(sessionKey(guestId, hotelId), JSON.stringify({ state, data }), "EX", SESSION_TTL);
  } catch (err) {
    log.warn({ err, guestId, hotelId }, "session redis SET failed");
  }
}

async function redisDel(guestId: string, hotelId: string): Promise<void> {
  try {
    await redis.del(sessionKey(guestId, hotelId));
  } catch (err) {
    log.warn({ err, guestId, hotelId }, "session redis DEL failed");
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOrCreateSession(guestId: string, hotelId: string) {
  // Try Redis first. A live key means the session was written within the 24h TTL,
  // so updatedAt = now is accurate enough for the 2-hour idle-expiry check in botEngine.
  const cached = await redisGet(guestId, hotelId);
  if (cached) {
    const now = new Date();
    return { guestId, hotelId, state: cached.state, data: cached.data as object, updatedAt: now, createdAt: now, id: "" };
  }

  // Miss — read from Postgres and backfill Redis
  const record = await prisma.conversationSession.upsert({
    where:  { guestId_hotelId: { guestId, hotelId } },
    update: {},
    create: { guestId, hotelId, state: "IDLE", data: {} },
  });

  redisSet(guestId, hotelId, record.state, record.data as SessionData).catch(() => {});
  return record;
}

export async function updateSession(
  guestId: string,
  hotelId: string,
  state: string,
  data: SessionData = {}
) {
  // Redis write is on the critical path (fast, in-memory)
  await redisSet(guestId, hotelId, state, data);

  // Postgres write is fire-and-forget — keeps the DB in sync without blocking the reply
  prisma.conversationSession.upsert({
    where:   { guestId_hotelId: { guestId, hotelId } },
    update:  { state, data: data as object },
    create:  { guestId, hotelId, state, data: data as object },
  }).catch((err) => log.error({ err, guestId, hotelId }, "session postgres updateSession failed"));

  return { guestId, hotelId, state, data: data as object };
}

export async function resetSession(guestId: string, hotelId: string) {
  // Redis: overwrite with IDLE immediately, then delete (single round-trip SET + DEL)
  await redisDel(guestId, hotelId);

  // Postgres fire-and-forget
  prisma.conversationSession.upsert({
    where:   { guestId_hotelId: { guestId, hotelId } },
    update:  { state: "IDLE", data: {} },
    create:  { guestId, hotelId, state: "IDLE", data: {} },
  }).catch((err) => log.error({ err, guestId, hotelId }, "session postgres resetSession failed"));
}
