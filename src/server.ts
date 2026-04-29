// ⚠️  loadEnv MUST be first — populates process.env before any other module reads it
import "./loadEnv";

import * as Sentry from "@sentry/node";

// Init Sentry before importing app so all Express handlers are instrumented
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn:              process.env.SENTRY_DSN,
    environment:      process.env.NODE_ENV ?? "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  });
}

import http from "http";
import { initSocket } from "./socket";
import app from "./app";
import { subscribeMessageStatus } from "./realtime/statusBus";
import { emitToHotel } from "./realtime/emit";
import prisma from "./db/connect";
import { logger } from "./utils/logger";
import { MessageStatus } from "@prisma/client";

// ── Startup environment validation ────────────────────────────────────────────

const REQUIRED_ENV: string[] = [
  "JWT_SECRET",
  "DATABASE_URL",
  "WHATSAPP_APP_SECRET", // HMAC verification of Meta webhook payloads
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.fatal({ missing }, "missing required env vars — aborting");
    process.exit(1);
  }

  // Warn about vars that degrade functionality when absent
  if (!process.env.REDIS_URL) {
    logger.warn("REDIS_URL not set — using redis://127.0.0.1:6379");
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    logger.warn("no AI API key set — AI fallback will be disabled");
  }
  if (!process.env.FRONTEND_ORIGIN) {
    logger.warn("FRONTEND_ORIGIN not set — defaulting to http://localhost:3000");
  }
  if (!process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
    logger.warn("R2_BUCKET_NAME / R2_PUBLIC_URL not set — media uploads will fall back to local disk");
  }
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    logger.warn("R2 credentials not set — media uploads will fall back to local disk");
  }
}

validateEnv();

// ── Startup sweep: resolve PENDING messages orphaned by a prior crash/restart ─
// The delayed-send timer (setTimeout in message.service.ts) lives in process
// memory. If the process dies while a timer is active, the message stays PENDING
// forever. Max configured delay is 60 s, so anything older than 2 min is stale.
async function sweepStalePendingMessages() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000);
  const result = await prisma.message.updateMany({
    where: {
      direction: "OUT",
      status:    MessageStatus.PENDING,
      timestamp: { lt: cutoff },
    },
    data: { status: MessageStatus.FAILED },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, "swept stale PENDING→FAILED messages on startup");
  }
}

sweepStalePendingMessages().catch((err) =>
  logger.error({ err }, "startup PENDING sweep failed")
);

// Recurring sweep — catches any messages that slip through after startup
const pendingSweepInterval = setInterval(
  () => sweepStalePendingMessages().catch((err) =>
    logger.error({ err }, "periodic PENDING sweep failed")
  ),
  5 * 60 * 1000 // every 5 minutes
).unref();

// ── Server setup ──────────────────────────────────────────────────────────────

const server = http.createServer(app);
export const io = initSocket(server);

// Bridge: worker publishes status updates to Redis → forward to Socket.IO
const unsubscribeStatus = subscribeMessageStatus(({ hotelId, messageId, status }) => {
  emitToHotel(hotelId, "message:status", { messageId, status });
});

const PORT = Number(process.env.PORT) || 5000;

server.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV ?? "development", aiProvider: process.env.AI_PROVIDER ?? "anthropic" }, "Vaketta backend started");
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "shutdown signal received — closing gracefully");

  clearInterval(pendingSweepInterval);
  unsubscribeStatus();

  server.close(async () => {
    try {
      await prisma.$disconnect();
      logger.info("database connection closed");
    } catch (err) {
      logger.error({ err }, "error closing database connection");
    }
    logger.info("server closed — exiting");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("forced shutdown after timeout");
    process.exit(1);
  }, 15_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Log unhandled promise rejections instead of crashing silently
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  shutdown("uncaughtException");
});
