/**
 * billing.worker.ts
 *
 * Lightweight cron worker that expires overdue hotel subscriptions and trials.
 * Runs inside the same worker process as the WhatsApp queue (imported by
 * whatsapp.worker.ts entry point via the combined worker script).
 *
 * Runs every 30 minutes — safe to run frequently because the DB query only
 * updates rows where billingEndDate < now AND status is "active" or "trial".
 *
 * A Redis SET NX lock prevents duplicate runs when multiple worker replicas
 * are deployed. The lock TTL (5 min) exceeds the expected job duration and is
 * shorter than the cron interval, so it always expires before the next tick.
 */

import { expireOverdueSubscriptions } from "../services/billing.service";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";

const log = logger.child({ service: "billing-worker" });

const INTERVAL_MS    = 30 * 60 * 1000; // 30 minutes
const LOCK_KEY       = "billing:lock:expiry";
const LOCK_TTL_SECS  = 5 * 60; // 5 minutes — auto-expires if job crashes

async function runExpiry() {
  // Acquire distributed lock — only one worker instance runs per interval
  const acquired = await redis.set(LOCK_KEY, "1", "EX", LOCK_TTL_SECS, "NX");
  if (!acquired) return;

  try {
    const count = await expireOverdueSubscriptions();
    if (count > 0) {
      log.info({ count }, "expired overdue subscriptions");
    }
  } catch (err) {
    log.error({ err }, "billing expiry job failed");
  } finally {
    await redis.del(LOCK_KEY);
  }
}

// Run immediately on startup, then on interval
runExpiry();
setInterval(runExpiry, INTERVAL_MS);

log.info({ intervalMs: INTERVAL_MS }, "billing expiry worker started");
