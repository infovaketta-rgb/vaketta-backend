"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const whatsapp_controller_1 = require("../controllers/whatsapp.controller");
const router = (0, express_1.Router)();
// Bug 1: Meta requires a GET endpoint to verify the webhook during setup
router.get("/", whatsapp_controller_1.verifyWhatsAppWebhook);
router.post("/", whatsapp_controller_1.handleWhatsAppWebhook);
exports.default = router;
//# sourceMappingURL=whatsapp.routes.js.map