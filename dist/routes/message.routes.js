"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const message_controller_1 = require("../controllers/message.controller");
const storage = multer_1.default.diskStorage({
    destination: path_1.default.join(process.cwd(), "uploads"),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname);
        cb(null, `${(0, crypto_1.randomUUID)()}${ext}`);
    },
});
const upload = (0, multer_1.default)({ storage, limits: { fileSize: 64 * 1024 * 1024 } }); // 64 MB max
const router = (0, express_1.Router)();
router.post("/reply", message_controller_1.manualReply);
router.post("/send-media", upload.single("file"), message_controller_1.sendMedia);
router.get("/:guestId", message_controller_1.getMessages);
router.post("/:guestId/read", message_controller_1.markMessagesRead);
router.patch("/:guestId/bot", message_controller_1.setBotEnabled);
exports.default = router;
//# sourceMappingURL=message.routes.js.map