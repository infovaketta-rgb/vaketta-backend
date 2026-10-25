/**
 * bootstrap/env.ts
 *
 * Single source of truth for environment validation. Extracted from server.ts
 * so startup wiring stays declarative and this logic is unit-testable.
 *
 * Contract:
 *   • REQUIRED vars missing  → log fatal + process.exit(1) (fail fast, helpful error)
 *   • OPTIONAL-with-default  → warn once, behaviour degrades gracefully
 *
 * Variable NAMES are unchanged from the original inline validation — do not rename.
 */
import { logger } from "../utils/logger";

const log = logger.child({ service: "env" });

// Hard requirements — the process cannot function safely without these.
const REQUIRED_ENV: readonly string[] = [
  "JWT_SECRET",
  "DATABASE_URL",
  "FACEBOOK_APP_SECRET", // HMAC verification of Meta webhook payloads
];

/**
 * Validates process.env. Exits the process with a helpful message if any
 * required variable is missing; otherwise warns about optional vars whose
 * absence degrades functionality.
 */
export function validateEnv(): void {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    log.fatal({ missing }, "missing required env vars — aborting startup");
    // eslint-disable-next-line no-console
    console.error(
      `\nFATAL: missing required environment variables: ${missing.join(", ")}\n` +
        `Set them in your .env file or container environment and restart.\n`,
    );
    process.exit(1);
  }

  // ── Optional vars — warn, then fall back to a sensible default at the call site ─
  if (!process.env.REDIS_URL) {
    log.warn("REDIS_URL not set — defaulting to redis://127.0.0.1:6379");
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    log.warn("no AI API key set (ANTHROPIC_API_KEY / OPENAI_API_KEY) — AI fallback disabled");
  }
  if (!process.env.FRONTEND_ORIGIN) {
    log.warn("FRONTEND_ORIGIN not set — CORS defaulting to https://www.vaketta.com");
  }
  if (!process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
    log.warn("R2_BUCKET_NAME / R2_PUBLIC_URL not set — media uploads fall back to local disk");
  }
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    log.warn("R2 credentials not set — media uploads fall back to local disk");
  }
  // Instagram guest profile enrichment — all three default to a working state,
  // so these are informational only.
  if (process.env.INSTAGRAM_PROFILE_ENRICHMENT_ENABLED === "false") {
    log.warn("INSTAGRAM_PROFILE_ENRICHMENT_ENABLED=false — Instagram guest profiles will not be fetched");
  }
  if (!process.env.INSTAGRAM_PROFILE_TTL_HOURS) {
    log.warn("INSTAGRAM_PROFILE_TTL_HOURS not set — defaulting to 24 h between profile refreshes");
  }
  // Razorpay — optional by design. An unconfigured deployment must keep billing
  // manually rather than refuse to boot, so these warn and never exit(1).
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    log.warn("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — online payment is disabled");
  } else if (!process.env.RAZORPAY_KEY_ID.startsWith("rzp_test_")) {
    log.warn("RAZORPAY_KEY_ID is not a test key — this build only supports Razorpay TEST mode");
  }
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    log.warn("RAZORPAY_WEBHOOK_SECRET not set — the Razorpay webhook will reject every delivery");
  }
  if (process.env.RAZORPAY_ENABLED === "false") {
    log.warn("RAZORPAY_ENABLED=false — online payment endpoints will return 503");
  }
  if (process.env.MOCK_RAZORPAY === "true") {
    log.warn("MOCK_RAZORPAY=true — Razorpay orders are fixtures, no API call");
  }
  if (process.env.MOCK_INSTAGRAM_PROFILE === "true") {
    log.warn("MOCK_INSTAGRAM_PROFILE=true — Instagram profile fetches return a fixture, no Graph call");
  }
}
