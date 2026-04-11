import express, { Application, Request, Response, NextFunction } from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import hotelRoutes from "./routes/hotel.routes";
import { verifyWebhookSignature } from "./middleware/verifyWebhookSignature";
import { verifyWhatsAppWebhook, handleWhatsAppWebhook } from "./controllers/whatsapp.controller";
import messageRoutes from "./routes/message.routes";
import conversationRoutes from "./routes/conversation.routes";
import { auth } from "./middleware/auth.middleware";
import bookingRoutes from "./routes/booking.routes";
import roomTypeRoutes from "./routes/roomType.routes";
import authRoutes from "./routes/auth.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import settingsRoutes from "./routes/settings.routes";

const app: Application = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());
app.use(cookieParser());

// ── CORS ──────────────────────────────────────────────────────────────────────
// Origin is resolved at request time (not at import time) so dotenv is already loaded.
app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server (no origin) and ngrok tunnel
      if (!origin) return callback(null, true);

      const allowed = (process.env.FRONTEND_ORIGIN || "https://www.vaketta.com")
        .split(",")
        .map((o) => o.trim());

      // Always permit ngrok tunnels (used during development)
      const isNgrok = origin.endsWith(".ngrok-free.app") || origin.endsWith(".ngrok.io") || origin.includes("ngrok");

      if (allowed.includes(origin) || isNgrok) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Blocked origin: ${origin}`);
        callback(new Error(`Origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);

// ── Body parsing (skip /webhook/* — raw body handled in its own chain) ────────
app.use((req, res, next) => {
  if (req.path.startsWith("/webhook/")) return next();
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    express.json({ strict: false, limit: "1mb" })(req, res, next);
  } else {
    next();
  }
});

// ── Rate limiters ─────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs:       15 * 60 * 1000, // 15 min
  max:            10,
  message:        { error: "Too many login attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders:  false,
});

// Meta sends webhooks at burst rates; limit to prevent abuse if credentials leak
const webhookLimiter = rateLimit({
  windowMs:        10 * 1000, // 10 seconds
  max:             500,
  standardHeaders: true,
  legacyHeaders:   false,
  // Key by raw IP — not by user (no auth on webhooks)
  keyGenerator: (req) => (req.headers["x-forwarded-for"] as string ?? req.ip ?? "unknown"),
  skip: () => process.env.NODE_ENV === "test",
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.use("/auth/login",  loginLimiter);
app.use("/auth",        authRoutes);
app.use("/admin/login", loginLimiter);
app.use("/admin",       hotelRoutes);

// ── Conversations ─────────────────────────────────────────────────────────────
app.use("/conversations", auth, conversationRoutes);

// ── WhatsApp webhook ──────────────────────────────────────────────────────────
// GET: Meta verification challenge — no body, no signature
app.get("/webhook/whatsapp", webhookLimiter, verifyWhatsAppWebhook);

// POST: capture raw buffer → verify HMAC signature → dispatch
app.post(
  "/webhook/whatsapp",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  (req: any, _res: any, next: any) => {
    req.rawBody = req.body; // Buffer kept for HMAC check
    try {
      req.body = JSON.parse(req.body);
    } catch {
      console.warn("⚠️  WhatsApp webhook: invalid JSON — ignoring");
      return _res.sendStatus(200); // always ACK Meta
    }
    next();
  },
  verifyWebhookSignature,
  handleWhatsAppWebhook,
);

// ── Instagram webhook (future channel) ───────────────────────────────────────
// Uncomment and wire up instagram.controller.ts when Instagram DM is enabled.
// import instagramRoutes from "./routes/instagram.routes";
// app.use("/webhook/instagram", webhookLimiter, instagramRoutes);

// ── Static uploads ────────────────────────────────────────────────────────────
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ── Protected API routes ──────────────────────────────────────────────────────
app.use("/messages",       auth, messageRoutes);
app.use("/bookings",       auth, bookingRoutes);
app.use("/room-types",     auth, roomTypeRoutes);
app.use("/dashboard",      auth, dashboardRoutes);
app.use("/hotel-settings", auth, settingsRoutes);

// ── Health + root ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Vaketta Backend Running 🚀"));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status:  "ok",
    service: "vaketta-backend",
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV ?? "development",
  });
});

// ── Global error handler (must be last) ──────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status  = err.status ?? err.statusCode ?? 500;
  const message = status < 500 ? err.message : "Internal Server Error";

  if (status >= 500) {
    console.error("❌ Global error:", err);
  }

  res.status(status).json({ success: false, error: message });
});

export default app;
