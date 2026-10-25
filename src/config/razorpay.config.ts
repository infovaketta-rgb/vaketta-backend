/**
 * config/razorpay.config.ts
 *
 * Razorpay credentials and feature gating. Read at CALL TIME, never at module
 * load, so dotenv has already run and tests can flip env vars between cases —
 * the same reason `queue/redis.ts` reads REDIS_URL inside `createRedis()`.
 *
 * SECRET BOUNDARY (the single most important rule in this file):
 *   • RAZORPAY_KEY_ID      — publishable. Reaches the browser, but ONLY via the
 *                            order-creation response, never baked in at build
 *                            time. Test↔live then needs no frontend rebuild.
 *   • RAZORPAY_KEY_SECRET  — server only. Signs the Orders API call and verifies
 *                            the checkout callback.
 *   • RAZORPAY_WEBHOOK_SECRET — server only, and DISTINCT from KEY_SECRET.
 *                            Razorpay signs webhooks with a separate secret you
 *                            choose in the dashboard; using KEY_SECRET here is a
 *                            common integration bug that silently rejects every
 *                            webhook.
 * Nothing in this module may ever be logged.
 *
 * TEST MODE ONLY (Stage 2B). Razorpay encodes the mode in the key id itself:
 * `rzp_test_*` vs `rzp_live_*`. `assertTestMode()` refuses to run against a live
 * key, so a mis-set production credential fails loudly at order creation instead
 * of quietly charging a real card.
 */

export type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

/** Feature gate. Mirrors INSTAGRAM_OUTBOUND_ENABLED — on unless explicitly "false". */
export function isRazorpayEnabled(): boolean {
  return process.env.RAZORPAY_ENABLED !== "false";
}

/** Fixture mode — no network call. Mirrors MOCK_INSTAGRAM_SEND. */
export function isRazorpayMocked(): boolean {
  return process.env.MOCK_RAZORPAY === "true";
}

/**
 * Credentials, or null when unconfigured.
 *
 * Returns null rather than throwing so an unconfigured deployment degrades to
 * "online payment unavailable" (a 503 the UI can explain) instead of a 500 —
 * and so `bootstrap/env.ts` can keep these as optional-with-warn rather than
 * exiting the process. Manual/offline billing must keep working without them.
 */
export function getRazorpayConfig(): RazorpayConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();

  if (!keyId || !keySecret) return null;
  // Webhook secret is allowed to be absent at order-creation time (a deployment
  // may configure the dashboard webhook later); the webhook route enforces its
  // own presence and refuses to verify without it.
  return { keyId, keySecret, webhookSecret: webhookSecret ?? "" };
}

/** Webhook secret alone — the webhook path needs it without needing API keys. */
export function getRazorpayWebhookSecret(): string | null {
  const s = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  return s ? s : null;
}

/**
 * Stage 2B is test mode only.
 *
 * Razorpay key ids are prefixed `rzp_test_` / `rzp_live_`, so the mode is
 * knowable without a network call. Refusing a live key here is what makes
 * "test mode only" an enforced property rather than a note in a README.
 */
export function assertTestMode(keyId: string): void {
  if (keyId.startsWith("rzp_live_")) {
    throw new Error(
      "RAZORPAY_KEY_ID is a LIVE key. Stage 2B is test-mode only — set a rzp_test_* key.",
    );
  }
}

/** ISO 4217 codes Razorpay may be used for in this stage. */
export const SUPPORTED_CURRENCIES = ["INR"] as const;

export function isSupportedCurrency(currency: string): boolean {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency.toUpperCase());
}
