/**
 * bootstrap/shutdown.ts
 *
 * Graceful shutdown wiring. On SIGTERM/SIGINT (and as a last resort on an
 * uncaught exception) we:
 *   1. stop accepting new work (close HTTP server + Socket.IO)
 *   2. stop background timers (crons, pending-message sweep)
 *   3. release external connections (Prisma, Redis pub/sub subscriber)
 *   4. exit 0 — or force-exit 1 if it takes longer than the deadline
 *
 * BullMQ workers keep their own connection to the shared `redis` client; they
 * drain in-flight jobs when the process exits. We do not close the shared redis
 * client explicitly because Queues/Workers share it and closing mid-drain can
 * throw; the process exit tears it down.
 */
import type { Server as HttpServer } from "http";
import type { Server as IoServer } from "socket.io";
import type { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const log = logger.child({ service: "shutdown" });

export interface ShutdownResources {
  httpServer:  HttpServer;
  io:          IoServer;
  prisma:      PrismaClient;
  /** Cleanup callbacks (crons stop, status-bus unsubscribe, interval clears). */
  cleanups:    Array<() => void | Promise<void>>;
  /** Milliseconds to wait before forcing exit. */
  timeoutMs?:  number;
}

/** Registers SIGTERM/SIGINT/uncaughtException handlers. Call once from server.ts. */
export function registerShutdown(resources: ShutdownResources): void {
  const { httpServer, io, prisma, cleanups, timeoutMs = 15_000 } = resources;
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info({ signal }, "shutdown signal received — closing gracefully");

    // Force-exit guard: never hang the container on a stuck connection.
    const forceTimer = setTimeout(() => {
      log.error({ timeoutMs }, "forced shutdown after timeout");
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    // 1. Run synchronous/async cleanups (crons, timers, status-bus unsubscribe).
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (err) {
        log.warn({ err }, "cleanup callback failed during shutdown");
      }
    }

    // 2. Stop accepting new connections.
    io.close();
    httpServer.close(async () => {
      // 3. Release the database connection.
      try {
        await prisma.$disconnect();
        log.info("database connection closed");
      } catch (err) {
        log.error({ err }, "error closing database connection");
      }
      log.info("server closed — exiting");
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "unhandled promise rejection");
  });

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception — shutting down");
    void shutdown("uncaughtException");
  });

  // Surface EventEmitter leak warnings in the structured log.
  process.on("warning", (warning) => {
    log.warn({ name: warning.name, message: warning.message, stack: warning.stack }, "process warning");
  });
}
