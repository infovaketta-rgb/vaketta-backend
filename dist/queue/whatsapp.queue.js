"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.whatsappQueue = void 0;
const bullmq_1 = require("bullmq");
const redis_1 = require("./redis");
exports.whatsappQueue = new bullmq_1.Queue("whatsapp-out", {
    connection: redis_1.redis,
});
//# sourceMappingURL=whatsapp.queue.js.map