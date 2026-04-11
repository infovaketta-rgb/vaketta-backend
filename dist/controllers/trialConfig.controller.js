"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTrialConfigHandler = getTrialConfigHandler;
exports.updateTrialConfigHandler = updateTrialConfigHandler;
const trialConfig_service_1 = require("../services/trialConfig.service");
// GET /admin/trial-config
async function getTrialConfigHandler(_req, res) {
    try {
        const config = await (0, trialConfig_service_1.getTrialConfig)();
        res.json(config);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// PATCH /admin/trial-config
async function updateTrialConfigHandler(req, res) {
    try {
        const { durationDays, conversationLimit, aiReplyLimit, autoStartOnCreate, trialMessage } = req.body;
        const config = await (0, trialConfig_service_1.updateTrialConfig)({
            ...(durationDays != null && { durationDays: Math.max(1, Math.min(365, Number(durationDays))) }),
            ...(conversationLimit != null && { conversationLimit: Math.max(0, Number(conversationLimit)) }),
            ...(aiReplyLimit != null && { aiReplyLimit: Math.max(0, Number(aiReplyLimit)) }),
            ...(autoStartOnCreate != null && { autoStartOnCreate: Boolean(autoStartOnCreate) }),
            ...(trialMessage != null && { trialMessage: String(trialMessage).trim() }),
        });
        res.json(config);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
//# sourceMappingURL=trialConfig.controller.js.map