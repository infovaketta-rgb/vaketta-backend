"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCalendarHandler = getCalendarHandler;
exports.patchCellHandler = patchCellHandler;
exports.bulkPatchHandler = bulkPatchHandler;
exports.getToggleHandler = getToggleHandler;
exports.patchToggleHandler = patchToggleHandler;
const availability_service_1 = require("../services/availability.service");
function hotelId(req) {
    return req.user?.hotelId;
}
// GET /hotel-settings/availability/calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
async function getCalendarHandler(req, res) {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: "startDate and endDate are required" });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
            return res.status(400).json({ error: "Dates must be YYYY-MM-DD" });
        }
        const diffDays = (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000;
        if (diffDays < 1 || diffDays > 90) {
            return res.status(400).json({ error: "Date range must be 1–90 days" });
        }
        const data = await (0, availability_service_1.getCalendarData)(hotelId(req), startDate, endDate);
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// PATCH /hotel-settings/availability/cell
async function patchCellHandler(req, res) {
    try {
        const { roomTypeId, date, availableRooms, price } = req.body;
        if (!roomTypeId || !date || availableRooms === undefined) {
            return res.status(400).json({ error: "roomTypeId, date and availableRooms are required" });
        }
        const row = await (0, availability_service_1.upsertInventoryCell)(hotelId(req), roomTypeId, date, Number(availableRooms), price !== undefined && price !== "" ? Number(price) : null);
        res.json(row);
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
}
// PATCH /hotel-settings/availability/bulk
async function bulkPatchHandler(req, res) {
    try {
        const { roomTypeId, startDate, endDate, availableRooms, price } = req.body;
        if (!roomTypeId || !startDate || !endDate || availableRooms === undefined) {
            return res.status(400).json({ error: "roomTypeId, startDate, endDate and availableRooms are required" });
        }
        const result = await (0, availability_service_1.bulkUpsertInventory)(hotelId(req), roomTypeId, startDate, endDate, Number(availableRooms), price !== undefined && price !== "" ? Number(price) : null);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
}
// GET /hotel-settings/availability/toggle
async function getToggleHandler(req, res) {
    try {
        const enabled = await (0, availability_service_1.getAvailabilityEnabled)(hotelId(req));
        res.json({ availabilityEnabled: enabled });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// PATCH /hotel-settings/availability/toggle
async function patchToggleHandler(req, res) {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== "boolean") {
            return res.status(400).json({ error: "enabled (boolean) is required" });
        }
        await (0, availability_service_1.setAvailabilityEnabled)(hotelId(req), enabled);
        res.json({ availabilityEnabled: enabled });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
//# sourceMappingURL=availability.controller.js.map