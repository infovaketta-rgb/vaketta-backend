/**
 * bootstrap/crons.ts
 *
 * Background cron jobs, consolidated into the single web process (see the
 * single-container migration). Each cron is guarded by a Redis SET NX lock so
 * that if the app is ever scaled to multiple instances, only one instance runs
 * a given tick — no duplicate expiries / duplicate template syncs.
 *
 * Previously: billing lived in billing.worker.ts (already locked) and template
 * sync lived inline in whatsapp.worker.ts (NOT locked). Both are now here, both
 * locked, both started exactly once by startCrons().
 */
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import { expireOverdueSubscriptions } from "../services/billing.service";
import { syncPendingTemplates } from "../services/templates.service";

const log = logger.child({ service: "crons" });

// ── Intervals ──────────────────────────────────────────────────────────────
const BILLING_INTERVAL_MS  = 30 * 60 * 1000;      // every 30 min
const TEMPLATE_INTERVAL_MS  = 24 * 60 * 60 * 1000; // every 24 h
const TEMPLATE_STARTUP_DELAY_MS = 5 * 60 * 1000;   // first template sync 5 min after boot

// ── Lock keys + TTLs (TTL < interval so the lock always clears before next tick)
const BILLING_LOCK_KEY   = "billing:lock:expiry";
const BILLING_LOCK_TTL   = 5 * 60;   // 5 min
const TEMPLATE_LOCK_KEY  = "templates:lock:sync";
const TEMPLATE_LOCK_TTL  = 10 * 60;  // 10 min

/** Run `fn` only if this instance wins the distributed lock; always release it. */
async function withLock(key: string, ttlSecs: number, fn: () => Promise<void>): Promise<void> {
  const acquired = await redis.set(key, "1", "EX", ttlSecs, "NX");
  if (!acquired) return; // another instance is handling this tick
  try {
    await fn();
  } finally {
    await redis.del(key).catch(() => {});
  }
}

async function runBillingExpiry(): Promise<void> {
  await withLock(BILLING_LOCK_KEY, BILLING_LOCK_TTL, async () => {
    const count = await expireOverdueSubscriptions();
    if (count > 0) log.info({ count }, "expired overdue subscriptions");
  });
}

async function runTemplateSync(): Promise<void> {
  await withLock(TEMPLATE_LOCK_KEY, TEMPLATE_LOCK_TTL, async () => {
    await syncPendingTemplates();
  });
}

/**
 * Starts all cron timers. Returns a stop() that clears them for graceful
 * shutdown. Idempotent guard prevents accidental double-start.
 */
let started = false;
export function startCrons(): () => void {
  if (started) {
    log.warn("startCrons() called twice — ignoring");
    return () => {};
  }
  started = true;

  // Billing — run immediately, then on interval.
  runBillingExpiry().catch((err) => log.error({ err }, "billing expiry failed"));
  const billingTimer = setInterval(() => {
    runBillingExpiry().catch((err) => log.error({ err }, "billing expiry failed"));
  }, BILLING_INTERVAL_MS);

  // Template sync — first run after a short delay (avoids competing with boot),
  // then daily.
  const templateStartupTimer = setTimeout(() => {
    runTemplateSync().catch((err) => log.error({ err }, "template startup sync failed"));
  }, TEMPLATE_STARTUP_DELAY_MS);
  const templateTimer = setInterval(() => {
    runTemplateSync().catch((err) => log.error({ err }, "template cron sync failed"));
  }, TEMPLATE_INTERVAL_MS);

  log.info(
    { billingIntervalMs: BILLING_INTERVAL_MS, templateIntervalMs: TEMPLATE_INTERVAL_MS },
    "crons started (billing, template-sync) — Redis SETNX locked",
  );

  return () => {
    clearInterval(billingTimer);
    clearTimeout(templateStartupTimer);
    clearInterval(templateTimer);
    started = false;
    log.info("crons stopped");
  };
}
