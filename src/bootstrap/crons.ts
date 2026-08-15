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
import { expireOverdueSubscriptions, renewDueSubscriptions } from "../services/billing.service";
import { advanceDelinquent, notifyRecentlySuspended, sendRenewalReminders } from "../services/dunning.service";
import { syncPendingTemplates } from "../services/templates.service";

const log = logger.child({ service: "crons" });

// ── Intervals ──────────────────────────────────────────────────────────────
const BILLING_INTERVAL_MS  = 30 * 60 * 1000;      // every 30 min
const TEMPLATE_INTERVAL_MS  = 24 * 60 * 60 * 1000; // every 24 h
const TEMPLATE_STARTUP_DELAY_MS = 5 * 60 * 1000;   // first template sync 5 min after boot

// ── Lock keys + TTLs (TTL < interval so the lock always clears before next tick)
const BILLING_LOCK_KEY   = "billing:lock:expiry";
// The billing tick used to be one `updateMany`; it now renews subscriptions,
// issues invoices and sends dunning email per hotel, so 5 min was no longer a
// safe upper bound on its runtime. Still well under the 30-min interval.
const BILLING_LOCK_TTL   = 20 * 60;  // 20 min
const TEMPLATE_LOCK_KEY  = "templates:lock:sync";
const TEMPLATE_LOCK_TTL  = 10 * 60;  // 10 min

/**
 * Release the lock ONLY if we still hold it.
 *
 * A plain `DEL` is unsafe: if `fn()` outran the TTL, the lock has already
 * expired and been re-acquired by another instance — deleting it would hand a
 * third instance a lock while the second is still running, i.e. exactly the
 * double-run the lock exists to prevent. Comparing the fencing token first
 * makes the release a no-op in that case.
 */
const UNLOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Run `fn` only if this instance wins the distributed lock; release it safely. */
async function withLock(key: string, ttlSecs: number, fn: () => Promise<void>): Promise<void> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(key, token, "EX", ttlSecs, "NX");
  if (!acquired) return; // another instance is handling this tick
  try {
    await fn();
  } finally {
    await redis.eval(UNLOCK_LUA, 1, key, token).catch(() => {});
  }
}

/**
 * The billing tick. Order matters:
 *   1. RENEW first — a subscription whose period just ended should roll into the
 *      next one and be invoiced, not be treated as lapsed. Running expiry first
 *      would suspend every paying hotel the moment its period ended.
 *   2. Then advance delinquency (overdue invoice → PAST_DUE → suspended).
 *   3. Then expire whatever genuinely ran out of time (ended trials, cancelled
 *      plans reaching their date).
 *   4. Then notify.
 *
 * Every pass is individually idempotent (see billing.service / dunning.service),
 * so a partial failure mid-tick is corrected on the next one. Each is also
 * wrapped so one failing pass cannot prevent the others from running — a broken
 * mail transport must not stop renewals.
 */
async function runBillingTick(): Promise<void> {
  await withLock(BILLING_LOCK_KEY, BILLING_LOCK_TTL, async () => {
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } catch (err) {
        log.error({ err, step: name }, "billing tick step failed");
        return null;
      }
    };

    const renewed = (await step("renew", renewDueSubscriptions)) as number | null;
    if (renewed) log.info({ count: renewed }, "renewed subscriptions");

    const delinquent = (await step("delinquent", advanceDelinquent)) as { pastDue: number; suspended: number } | null;
    if (delinquent?.pastDue || delinquent?.suspended) log.info(delinquent, "advanced delinquent hotels");

    const expired = (await step("expire", expireOverdueSubscriptions)) as number | null;
    if (expired) log.info({ count: expired }, "expired overdue subscriptions");

    const reminders = (await step("reminders", sendRenewalReminders)) as number | null;
    const suspendedNotices = (await step("suspendedNotices", notifyRecentlySuspended)) as number | null;
    if (reminders || suspendedNotices) log.info({ reminders, suspendedNotices }, "sent billing notices");
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
  runBillingTick().catch((err) => log.error({ err }, "billing tick failed"));
  const billingTimer = setInterval(() => {
    runBillingTick().catch((err) => log.error({ err }, "billing tick failed"));
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
