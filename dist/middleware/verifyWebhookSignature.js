"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyWebhookSignature = verifyWebhookSignature;
const crypto_1 = __importDefault(require("crypto"));
/**
 * Verifies the X-Hub-Signature-256 header that Meta signs every webhook payload with.
 * Rejects requests that don't match — prevents fake webhook injections.
 * Requires WHATSAPP_APP_SECRET in env (your Meta App Secret).
 */
function verifyWebhookSignature(req, res, next) {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
        console.warn("⚠️  WHATSAPP_APP_SECRET not set — skipping webhook signature verification");
        return next();
    }
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
        return res.status(401).json({ error: "Missing webhook signature" });
    }
    // Body must be the raw Buffer — express.json() must NOT have parsed it yet
    const rawBody = req.rawBody;
    if (!rawBody) {
        return res.status(500).json({ error: "Raw body unavailable for signature check" });
    }
    const expected = "sha256=" + crypto_1.default
        .createHmac("sha256", appSecret)
        .update(rawBody)
        .digest("hex");
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (sigBuffer.length !== expectedBuffer.length ||
        !crypto_1.default.timingSafeEqual(sigBuffer, expectedBuffer)) {
        return res.status(401).json({ error: "Invalid webhook signature" });
    }
    next();
}
//# sourceMappingURL=verifyWebhookSignature.js.map