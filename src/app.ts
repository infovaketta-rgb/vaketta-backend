import express, { Application, Request, Response, NextFunction } from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
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

const isProd = process.env.NODE_ENV === "production";
const app: Application = express();

// ── Trust proxy (required for correct IP behind Render / Railway / nginx) ─────
// "1" = trust exactly one hop (the platform's load balancer)
app.set("trust proxy", 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: isProd ? true : false,
    crossOriginEmbedderPolicy: false, // prevent issues with media from external CDN
  })
);
app.use(cookieParser());

// ── CORS ──────────────────────────────────────────────────────────────────────
// Origin resolved at request time so dotenv values are available.
const ALLOWED_ORIGINS = () =>
  (process.env.FRONTEND_ORIGIN || "https://www.vaketta.com")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Server-to-server requests (no Origin header) — always allow
      if (!origin) return callback(null, true);

      const allowed = ALLOWED_ORIGINS();

      // In development also allow ngrok tunnels
      const isNgrok = !isProd && origin.includes("ngrok");

      if (allowed.includes(origin) || isNgrok) {
        return callback(null, true);
      }

      console.warn(`[CORS] Blocked origin: ${origin}`);
      return callback(new Error(`Origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Cookie",
      "ngrok-skip-browser-warning",
    ],
    maxAge: 86400, // preflight cached for 24 h
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
// Skip /webhook/* paths — they need the raw buffer for HMAC verification
app.use((req, res, next) => {
  if (req.path.startsWith("/webhook/")) return next();
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    express.json({ strict: false, limit: "1mb" })(req, res, next);
  } else {
    next();
  }
});

// ── Rate limiters ─────────────────────────────────────────────────────────────

// Auth endpoints — strict to block brute force
const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15 min
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many login attempts. Try again in 15 minutes." },
});

// General API — prevent scraping / abuse
const apiLimiter = rateLimit({
  windowMs:        60 * 1000, // 1 min
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many requests. Please slow down." },
  skip:            () => !isProd, // only enforce in production
});

// Webhook — Meta sends bursts; generous limit, keyed by IP
const webhookLimiter = rateLimit({
  windowMs:        10 * 1000, // 10 s
  max:             500,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            () => process.env.NODE_ENV === "test",
});

// Apply general limiter to all routes except webhooks
app.use((req, res, next) => {
  if (req.path.startsWith("/webhook/")) return next();
  return apiLimiter(req, res, next);
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.use("/auth/login",  loginLimiter);
app.use("/auth",        authRoutes);
app.use("/admin/login", loginLimiter);
app.use("/admin",       hotelRoutes);

// ── Conversations ─────────────────────────────────────────────────────────────
app.use("/conversations", auth, conversationRoutes);

// ── WhatsApp webhook ──────────────────────────────────────────────────────────
// GET: Meta webhook verification challenge — no body, no signature needed
app.get("/webhook/whatsapp", webhookLimiter, verifyWhatsAppWebhook);

// POST: capture raw buffer → verify HMAC → parse → dispatch
app.post(
  "/webhook/whatsapp",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  (req: any, _res: any, next: any) => {
    req.rawBody = req.body; // Buffer preserved for HMAC check
    try {
      req.body = JSON.parse(req.body.toString());
    } catch {
      console.warn("⚠️  WhatsApp webhook: invalid JSON — ignoring");
      return _res.sendStatus(200); // always ACK Meta to prevent retries
    }
    next();
  },
  verifyWebhookSignature,
  handleWhatsAppWebhook,
);

// ── Static file serving ───────────────────────────────────────────────────────
app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads"), {
    maxAge: isProd ? "7d" : 0,       // cache uploads for 7 days in prod
    etag:   true,
    index:  false,                   // never serve directory listings
  })
);

// ── Protected API routes ──────────────────────────────────────────────────────
app.use("/messages",       auth, messageRoutes);
app.use("/bookings",       auth, bookingRoutes);
app.use("/room-types",     auth, roomTypeRoutes);
app.use("/dashboard",      auth, dashboardRoutes);
app.use("/hotel-settings", auth, settingsRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).json({
    status:  "ok",
    service: "vaketta-backend",
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV ?? "development",
  });
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.status(200).json({ service: "Vaketta Backend", status: "running" });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// ── Global error handler (must be last) ──────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status  = err.status ?? err.statusCode ?? 500;

  // Never leak internal error details to clients in production
  const message = isProd && status >= 500
    ? "Internal Server Error"
    : err.message ?? "Internal Server Error";

  if (status >= 500) {
    console.error("❌ Unhandled error:", err);
  }

  res.status(status).json({ success: false, error: message });
});

export default app;
