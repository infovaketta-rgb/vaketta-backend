/**
 * billing.worker.ts
 *
 * Lightweight cron worker that expires overdue hotel subscriptions and trials.
 * Runs inside the same worker process as the WhatsApp queue (imported by
 * whatsapp.worker.ts entry point via the combined worker script).
 *
 * Runs every 30 minutes — safe to run frequently because the DB query only
 * updates rows where billingEndDate < now AND status is "active" or "trial".
 */

import { expireOverdueSubscriptions } from "../services/billing.service";

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function runExpiry() {
  try {
    const count = await expireOverdueSubscriptions();
    if (count > 0) {
      console.log(`✅ [BillingWorker] Expired ${count} overdue subscription(s)`);
    }
  } catch (err) {
    console.error("❌ [BillingWorker] Expiry job failed:", err);
  }
}

// Run immediately on startup, then on interval
runExpiry();
setInterval(runExpiry, INTERVAL_MS);

console.log("🕐 Billing expiry worker started (runs every 30 min)");
