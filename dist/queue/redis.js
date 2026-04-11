"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
const ioredis_1 = require("ioredis");
exports.redis = new ioredis_1.Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null, // 🔑 REQUIRED by BullMQ
});
//# sourceMappingURL=redis.js.map