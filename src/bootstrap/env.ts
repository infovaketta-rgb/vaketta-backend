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
}
