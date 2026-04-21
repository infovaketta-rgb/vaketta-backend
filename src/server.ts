// ⚠️  loadEnv MUST be first — populates process.env before any other module reads it
import "./loadEnv";

import http from "http";
import { initSocket } from "./socket";
import app from "./app";
import { subscribeMessageStatus } from "./realtime/statusBus";
import { emitToHotel } from "./realtime/emit";
import prisma from "./db/connect";

// ── Startup environment validation ────────────────────────────────────────────

const REQUIRED_ENV: string[] = [
  "JWT_SECRET",
  "DATABASE_URL",
  "WHATSAPP_APP_SECRET", // HMAC verification of Meta webhook payloads
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ FATAL: Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Warn about vars that degrade functionality when absent
  if (!process.env.REDIS_URL) {
    console.warn("⚠️  REDIS_URL not set — using redis://127.0.0.1:6379");
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.warn("⚠️  No AI API key set — AI fallback will be disabled");
  }
  if (!process.env.FRONTEND_ORIGIN) {
    console.warn("⚠️  FRONTEND_ORIGIN not set — defaulting to http://localhost:3000");
  }
  if (!process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
    console.warn("⚠️  R2_BUCKET_NAME / R2_PUBLIC_URL not set — media uploads will fall back to local disk");
  }
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.warn("⚠️  R2 credentials not set — media uploads will fall back to local disk");
  }
}

validateEnv();

// ── Server setup ──────────────────────────────────────────────────────────────

const server = http.createServer(app);
export const io = initSocket(server);

// Bridge: worker publishes status updates to Redis → forward to Socket.IO
const unsubscribeStatus = subscribeMessageStatus(({ hotelId, messageId, status }) => {
  emitToHotel(hotelId, "message:status", { messageId, status });
});

const PORT = Number(process.env.PORT) || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Vaketta backend running on port ${PORT}`);
  console.log(`   Provider: ${process.env.AI_PROVIDER ?? "anthropic"}`);
  console.log(`   Env:      ${process.env.NODE_ENV ?? "development"}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 ${signal} received — shutting down gracefully...`);

  // Stop accepting new connections
  unsubscribeStatus();

  server.close(async () => {
    try {
      await prisma.$disconnect();
      console.log("✅ Database connection closed");
    } catch (err) {
      console.error("❌ Error closing DB:", err);
    }
    console.log("✅ Server closed — exiting");
    process.exit(0);
  });

  // Force exit after 15s if something hangs
  setTimeout(() => {
    console.error("❌ Forced shutdown after timeout");
    process.exit(1);
  }, 15_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Log unhandled promise rejections instead of crashing silently
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  shutdown("uncaughtException");
});
