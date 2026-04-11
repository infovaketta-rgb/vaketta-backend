"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTrialConfig = getTrialConfig;
exports.updateTrialConfig = updateTrialConfig;
const connect_1 = __importDefault(require("../db/connect"));
const SINGLETON_ID = "global";
async function getTrialConfig() {
    return connect_1.default.trialConfig.upsert({
        where: { id: SINGLETON_ID },
        update: {},
        create: { id: SINGLETON_ID },
    });
}
async function updateTrialConfig(data) {
    return connect_1.default.trialConfig.upsert({
        where: { id: SINGLETON_ID },
        update: data,
        create: { id: SINGLETON_ID, ...data },
    });
}
//# sourceMappingURL=trialConfig.service.js.map