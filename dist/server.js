"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
const http_1 = __importDefault(require("http"));
const dotenv_1 = __importDefault(require("dotenv"));
const socket_1 = require("./socket");
const app_1 = __importDefault(require("./app"));
const statusBus_1 = require("./realtime/statusBus");
const emit_1 = require("./realtime/emit");
dotenv_1.default.config();
if (!process.env.JWT_SECRET) {
    console.error("❌ FATAL: JWT_SECRET is not set in environment variables.");
    process.exit(1);
}
const server = http_1.default.createServer(app_1.default);
exports.io = (0, socket_1.initSocket)(server);
// Bridge: worker publishes status updates to Redis → forward to Socket.IO
(0, statusBus_1.subscribeMessageStatus)(({ hotelId, messageId, status }) => {
    (0, emit_1.emitToHotel)(hotelId, "message:status", { messageId, status });
});
const PORT = Number(process.env.PORT) || 5000;
console.log("🚀 Starting Hotel Automation Backend...");
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
//# sourceMappingURL=server.js.map