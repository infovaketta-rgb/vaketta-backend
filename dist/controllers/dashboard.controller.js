"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboard = getDashboard;
const dashboard_service_1 = require("../services/dashboard.service");
async function getDashboard(req, res) {
    try {
        const user = req.user;
        const hotelId = user?.hotelId;
        if (!hotelId) {
            return res.status(401).json({ error: "Missing hotel context" });
        }
        const data = await (0, dashboard_service_1.getDashboardData)(hotelId);
        return res.json(data);
    }
    catch (err) {
        console.error("❌ Dashboard failed:", err);
        return res.status(500).json({ error: "Failed to load dashboard" });
    }
}
//# sourceMappingURL=dashboard.controller.js.map