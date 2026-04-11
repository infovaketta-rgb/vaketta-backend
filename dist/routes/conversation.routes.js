"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const conversation_controller_1 = require("../controllers/conversation.controller");
const router = (0, express_1.Router)();
router.get("/", conversation_controller_1.getConversations);
exports.default = router;
//# sourceMappingURL=conversation.routes.js.map