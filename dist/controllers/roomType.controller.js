"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRoomTypeController = createRoomTypeController;
exports.getRoomTypesController = getRoomTypesController;
exports.updateRoomTypeController = updateRoomTypeController;
exports.deleteRoomTypeController = deleteRoomTypeController;
const roomType_service_1 = require("../services/roomType.service");
async function createRoomTypeController(req, res) {
    try {
        const hotelId = req.user?.hotelId; // ✅ fixed
        if (!hotelId)
            return res.status(401).json({ error: "Unauthorized" });
        const { name, basePrice, capacity, maxAdults, maxChildren, totalRooms } = req.body;
        if (!name || !basePrice) {
            return res.status(400).json({ error: "Name and basePrice are required" });
        }
        const roomType = await (0, roomType_service_1.createRoomType)({
            hotelId,
            name,
            basePrice: Number(basePrice),
            ...(capacity ? { capacity: Number(capacity) } : {}),
            ...(maxAdults ? { maxAdults: Number(maxAdults) } : {}),
            ...(maxChildren ? { maxChildren: Number(maxChildren) } : {}),
            ...(totalRooms ? { totalRooms: Number(totalRooms) } : {}),
        });
        res.json(roomType);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Create room type failed" });
    }
}
async function getRoomTypesController(req, res) {
    try {
        const hotelId = req.user?.hotelId; // ✅ fixed
        if (!hotelId)
            return res.status(401).json({ error: "Unauthorized" });
        const roomTypes = await (0, roomType_service_1.getRoomTypes)(hotelId);
        res.json(roomTypes);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Get room types failed" });
    }
}
async function updateRoomTypeController(req, res) {
    try {
        const hotelId = req.user?.hotelId; // ✅ fixed
        if (!hotelId)
            return res.status(401).json({ error: "Unauthorized" });
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: "Room type ID is required" });
        const { name, basePrice, capacity, maxAdults, maxChildren, totalRooms } = req.body;
        if (!name || !basePrice) {
            return res.status(400).json({ error: "Name and basePrice are required" });
        }
        const roomType = await (0, roomType_service_1.updateRoomType)({
            id,
            hotelId,
            name,
            basePrice: Number(basePrice),
            ...(capacity ? { capacity: Number(capacity) } : {}),
            ...(maxAdults ? { maxAdults: Number(maxAdults) } : {}),
            ...(maxChildren ? { maxChildren: Number(maxChildren) } : {}),
            ...(totalRooms ? { totalRooms: Number(totalRooms) } : {}),
        });
        res.json(roomType);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Update room type failed" });
    }
}
async function deleteRoomTypeController(req, res) {
    try {
        const hotelId = req.user?.hotelId; // ✅ fixed
        if (!hotelId)
            return res.status(401).json({ error: "Unauthorized" });
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: "Room type ID is required" });
        await (0, roomType_service_1.deleteRoomType)({ id, hotelId });
        res.json({ success: true });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Delete room type failed" });
    }
}
//# sourceMappingURL=roomType.controller.js.map