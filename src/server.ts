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

import { validateEnv } from "./bootstrap/env";
import { startWorkers } from "./bootstrap/workers";
import { startCrons } from "./bootstrap/crons";
import { registerShutdown } from "./bootstrap/shutdown";

const APP_VERSION = process.env.npm_package_version ?? "1.0.0";

// ── 1. Environment validation (exits(1) on missing required vars) ──────────────
validateEnv();

// ── 2. Stale-message sweep ─────────────────────────────────────────────────────
// Delayed sends are durable BullMQ jobs now, but a job can still fail terminally
// and leave a message PENDING. Max configured delay is 60 s, so anything OUT +
// PENDING older than 2 min is stale → mark FAILED.
async function sweepStalePendingMessages() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000);
  const result = await prisma.message.updateMany({
    where: { direction: "OUT", status: MessageStatus.PENDING, timestamp: { lt: cutoff } },
    data:  { status: MessageStatus.FAILED },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, "swept stale PENDING→FAILED messages");
  }
}

sweepStalePendingMessages().catch((err) =>
  logger.warn({ err }, "startup PENDING sweep failed — DB may not be ready yet"),
);

const pendingSweepInterval = setInterval(async () => {
  try {
    await sweepStalePendingMessages();
  } catch (err) {
    logger.warn({ err }, "sweepStalePendingMessages failed, skipping cycle");
  }
}, 5 * 60 * 1000).unref();

// ── 3. HTTP + Socket.IO ─────────────────────────────────────────────────────────
const server = http.createServer(app);
export const io = initSocket(server);
logger.info("Socket.IO initialised");

// Bridge: worker publishes status updates to Redis → forward to Socket.IO
const unsubscribeStatus = subscribeMessageStatus(({ hotelId, messageId, status }) => {
  emitToHotel(hotelId, "message:status", { messageId, status });
});

// ── 4. Background workers + crons ───────────────────────────────────────────────
startWorkers();
const stopCrons = startCrons();

// ── 5. Graceful shutdown ─────────────────────────────────────────────────────────
registerShutdown({
  httpServer: server,
  io,
  prisma,
  cleanups: [
    () => clearInterval(pendingSweepInterval),
    () => stopCrons(),
    () => unsubscribeStatus(),
  ],
});

// ── 6. Memory usage logger ───────────────────────────────────────────────────────
// heapUsed trending upward across restarts would indicate a leak. Keep well below
// the container limit; --max-old-space-size triggers GC before the OS OOM-kills.
setInterval(() => {
  const m = process.memoryUsage();
  logger.info({
    heapUsed:  `${Math.round(m.heapUsed  / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(m.heapTotal / 1024 / 1024)}MB`,
    rss:       `${Math.round(m.rss       / 1024 / 1024)}MB`,
    external:  `${Math.round(m.external  / 1024 / 1024)}MB`,
  }, "memory-usage");
}, 60_000).unref();

// ── 7. Listen ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 5000;

async function start() {
  // Eagerly connect Prisma so a bad DATABASE_URL fails loudly at boot instead of
  // on the first request. Redis connection status is logged by queue/redis.ts.
  try {
    await prisma.$connect();
    logger.info("Prisma connected");
  } catch (err) {
    logger.fatal({ err }, "failed to connect to database — aborting startup");
    process.exit(1);
  }

  server.listen(PORT, () => {
    logger.info(
      {
        version:    APP_VERSION,
        env:        process.env.NODE_ENV ?? "development",
        port:       PORT,
        aiProvider: process.env.AI_PROVIDER ?? "anthropic",
        redis:      process.env.REDIS_URL ? "configured" : "default(127.0.0.1:6379)",
        node:       process.version,
      },
      "Vaketta backend started",
    );
  });
}

start();
