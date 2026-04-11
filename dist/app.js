"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const hotel_routes_1 = __importDefault(require("./routes/hotel.routes"));
const verifyWebhookSignature_1 = require("./middleware/verifyWebhookSignature");
const whatsapp_controller_1 = require("./controllers/whatsapp.controller");
const message_routes_1 = __importDefault(require("./routes/message.routes"));
const conversation_routes_1 = __importDefault(require("./routes/conversation.routes"));
const auth_middleware_1 = require("./middleware/auth.middleware");
const booking_routes_1 = __importDefault(require("./routes/booking.routes"));
const roomType_routes_1 = __importDefault(require("./routes/roomType.routes"));
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const dashboard_routes_1 = __importDefault(require("./routes/dashboard.routes"));
const settings_routes_1 = __importDefault(require("./routes/settings.routes"));
const app = (0, express_1.default)();
app.use((0, helmet_1.default)());
app.use((0, cookie_parser_1.default)());
const allowedOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
app.use((0, cors_1.default)({ origin: allowedOrigin, credentials: true }));
app.use((req, res, next) => {
    // Bug A: exclude /webhook/* — raw body is handled in the webhook chain
    if (req.path.startsWith("/webhook/"))
        return next();
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
        express_1.default.json({ strict: false, limit: "1mb" })(req, res, next);
    }
    else {
        next();
    }
});
const loginLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many login attempts. Try again in 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});
// loginLimiter MUST be registered before authRoutes
app.use("/auth/login", loginLimiter);
app.use("/auth", auth_routes_1.default);
app.use("/admin/login", loginLimiter);
app.use("/admin", hotel_routes_1.default);
app.use("/conversations", auth_middleware_1.auth, conversation_routes_1.default);
// Bug B: GET must be registered before the raw-body chain — it has no body and no signature
app.get("/webhook/whatsapp", whatsapp_controller_1.verifyWhatsAppWebhook);
// POST: capture raw body first (needed for HMAC), then verify signature, then handle
app.post("/webhook/whatsapp", express_1.default.raw({ type: "application/json", limit: "1mb" }), (req, res, next) => {
    req.rawBody = req.body; // Buffer for HMAC verification
    try {
        req.body = JSON.parse(req.body);
    }
    catch {
        console.warn("⚠️ WhatsApp webhook: invalid JSON payload, ignoring");
        return res.sendStatus(200);
    }
    next();
}, verifyWebhookSignature_1.verifyWebhookSignature, whatsapp_controller_1.handleWhatsAppWebhook);
// Serve uploaded media files (images, videos, audio, documents)
app.use("/uploads", express_1.default.static(path_1.default.join(process.cwd(), "uploads")));
app.use("/messages", auth_middleware_1.auth, message_routes_1.default);
app.use("/bookings", auth_middleware_1.auth, booking_routes_1.default);
app.use("/room-types", auth_middleware_1.auth, roomType_routes_1.default);
app.use("/dashboard", auth_middleware_1.auth, dashboard_routes_1.default);
app.use("/hotel-settings", auth_middleware_1.auth, settings_routes_1.default);
app.get("/", (_req, res) => {
    res.send("Hotel Automation Backend Running 🚀");
});
app.get("/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
        service: "hotel-automation-backend",
        time: new Date().toISOString()
    });
});
//always last section before export
app.use((err, _req, res, _next) => {
    console.error("❌ Global Error:", err);
    res.status(500).json({
        success: false,
        message: "Internal Server Error"
    });
});
exports.default = app;
//# sourceMappingURL=app.js.map