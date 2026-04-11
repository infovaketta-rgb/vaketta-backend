"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHotelFlowsHandler = getHotelFlowsHandler;
exports.getHotelFlowHandler = getHotelFlowHandler;
exports.createHotelFlowHandler = createHotelFlowHandler;
exports.updateHotelFlowHandler = updateHotelFlowHandler;
exports.deleteHotelFlowHandler = deleteHotelFlowHandler;
exports.adminListFlowsHandler = adminListFlowsHandler;
exports.adminGetFlowHandler = adminGetFlowHandler;
exports.adminCreateFlowHandler = adminCreateFlowHandler;
exports.adminUpdateFlowHandler = adminUpdateFlowHandler;
exports.adminDeleteFlowHandler = adminDeleteFlowHandler;
const flow_service_1 = require("../services/flow.service");
// ── Hotel-facing handlers ─────────────────────────────────────────────────────
async function getHotelFlowsHandler(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const flows = await (0, flow_service_1.getHotelFlows)(hotelId);
        res.json(flows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function getHotelFlowHandler(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const flow = await (0, flow_service_1.getHotelFlow)(req.params["id"], hotelId);
        if (!flow)
            return res.status(404).json({ error: "Flow not found" });
        res.json(flow);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function createHotelFlowHandler(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const { name, description, nodes, edges } = req.body;
        if (!name)
            return res.status(400).json({ error: "name is required" });
        const flow = await (0, flow_service_1.createHotelFlow)(hotelId, { name, description, nodes, edges });
        res.status(201).json(flow);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function updateHotelFlowHandler(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const { name, description, nodes, edges, isActive } = req.body;
        const flow = await (0, flow_service_1.updateHotelFlow)(req.params["id"], hotelId, { name, description, nodes, edges, isActive });
        res.json(flow);
    }
    catch (err) {
        const status = err.message.includes("access denied") ? 403 : 500;
        res.status(status).json({ error: err.message });
    }
}
async function deleteHotelFlowHandler(req, res) {
    try {
        const hotelId = req.user.hotelId;
        await (0, flow_service_1.deleteHotelFlow)(req.params["id"], hotelId);
        res.json({ success: true });
    }
    catch (err) {
        const status = err.message.includes("access denied") ? 403 : 500;
        res.status(status).json({ error: err.message });
    }
}
// ── Admin-facing handlers ─────────────────────────────────────────────────────
async function adminListFlowsHandler(req, res) {
    try {
        const isTemplate = req.query["isTemplate"] !== undefined
            ? req.query["isTemplate"] === "true"
            : undefined;
        const hotelId = req.query["hotelId"];
        const flows = await (0, flow_service_1.getAllFlows)({
            ...(isTemplate !== undefined && { isTemplate }),
            ...(hotelId !== undefined && { hotelId: hotelId === "null" ? null : hotelId }),
        });
        res.json(flows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function adminGetFlowHandler(req, res) {
    try {
        const flow = await (0, flow_service_1.getAdminFlow)(req.params["id"]);
        if (!flow)
            return res.status(404).json({ error: "Flow not found" });
        res.json(flow);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function adminCreateFlowHandler(req, res) {
    try {
        const { name, description, nodes, edges, isTemplate, hotelId } = req.body;
        if (!name)
            return res.status(400).json({ error: "name is required" });
        const flow = await (0, flow_service_1.createAdminFlow)({
            name, description, nodes, edges,
            isTemplate: Boolean(isTemplate),
            hotelId: hotelId ?? null,
        });
        res.status(201).json(flow);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function adminUpdateFlowHandler(req, res) {
    try {
        const { name, description, nodes, edges, isActive, isTemplate, hotelId } = req.body;
        const flow = await (0, flow_service_1.updateAdminFlow)(req.params["id"], {
            name, description, nodes, edges, isActive, isTemplate,
            ...(hotelId !== undefined && { hotelId: hotelId === null ? null : hotelId }),
        });
        res.json(flow);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function adminDeleteFlowHandler(req, res) {
    try {
        await (0, flow_service_1.deleteAdminFlow)(req.params["id"]);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
//# sourceMappingURL=flow.controller.js.map