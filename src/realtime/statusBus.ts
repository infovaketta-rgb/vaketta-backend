/**
 * Redis pub/sub bridge for message status updates.
 *
 * The BullMQ worker runs in a separate process and cannot import the
 * Socket.IO server directly. Instead, the worker publishes status changes
 * to Redis; the main server subscribes and forwards them to Socket.IO.
 */
import { createRedisClient } from "../queue/redis";
import { logger } from "../utils/logger";

const log = logger.child({ service: "status-bus" });

const CHANNEL = "message:status:update";

// Singleton publisher reused across the worker process
let _publisher: ReturnType<typeof createRedisClient> | null = null;
function getPublisher() {
  if (!_publisher) _publisher = createRedisClient("status-pub");
  return _publisher;
}

export type StatusUpdatePayload = {
  hotelId:   string;
  messageId: string;
  status:    string;
};

/** Called from the worker process after a DB status update. */
export function publishMessageStatus(payload: StatusUpdatePayload): void {
  getPublisher()
    .publish(CHANNEL, JSON.stringify(payload))
    .catch((err) => log.error({ err }, "status bus publish error"));
}

/** Called once from the main server process at startup.
 *  Returns a cleanup function — call it during graceful shutdown. */
export function subscribeMessageStatus(
  onUpdate: (payload: StatusUpdatePayload) => void
): () => void {
  const sub = createRedisClient("status-sub");
  sub.subscribe(CHANNEL, (err) => {
    if (err) log.error({ err }, "status bus subscribe error");
  });
  sub.on("message", (_channel, raw) => {
    try {
      onUpdate(JSON.parse(raw));
    } catch {
      log.warn({ raw }, "status bus received invalid payload");
    }
  });
  return () => { sub.quit().catch(() => {}); };
}
