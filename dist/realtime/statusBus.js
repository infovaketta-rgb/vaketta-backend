"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishMessageStatus = publishMessageStatus;
exports.subscribeMessageStatus = subscribeMessageStatus;
/**
 * Redis pub/sub bridge for message status updates.
 *
 * The BullMQ worker runs in a separate process and cannot import the
 * Socket.IO server directly. Instead, the worker publishes status changes
 * to Redis; the main server subscribes and forwards them to Socket.IO.
 */
const ioredis_1 = require("ioredis");
const CHANNEL = "message:status:update";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
// Singleton publisher reused across the worker process
let _publisher = null;
function getPublisher() {
    if (!_publisher) {
        _publisher = new ioredis_1.Redis(REDIS_URL, { maxRetriesPerRequest: null });
    }
    return _publisher;
}
/** Called from the worker process after a DB status update */
function publishMessageStatus(payload) {
    getPublisher().publish(CHANNEL, JSON.stringify(payload)).catch((err) => console.error("❌ Redis publish error:", err));
}
/** Called once from the main server process at startup */
function subscribeMessageStatus(onUpdate) {
    const sub = new ioredis_1.Redis(REDIS_URL, { maxRetriesPerRequest: null });
    sub.subscribe(CHANNEL, (err) => {
        if (err)
            console.error("❌ Redis subscribe error:", err);
    });
    sub.on("message", (_channel, raw) => {
        try {
            onUpdate(JSON.parse(raw));
        }
        catch {
            console.warn("⚠️ Invalid status bus payload:", raw);
        }
    });
}
//# sourceMappingURL=statusBus.js.map