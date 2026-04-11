"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRoomType = createRoomType;
exports.getRoomTypes = getRoomTypes;
exports.updateRoomType = updateRoomType;
exports.deleteRoomType = deleteRoomType;
const connect_1 = __importDefault(require("../db/connect"));
async function createRoomType({ hotelId, name, basePrice, capacity, maxAdults, maxChildren, totalRooms, }) {
    return connect_1.default.roomType.create({
        data: {
            hotelId,
            name,
            basePrice,
            capacity: capacity ?? null,
            maxAdults: maxAdults ?? null,
            maxChildren: maxChildren ?? null,
            totalRooms: totalRooms ?? 1,
        },
    });
}
async function getRoomTypes(hotelId) {
    return connect_1.default.roomType.findMany({
        where: { hotelId },
        orderBy: { createdAt: "asc" },
    });
}
async function updateRoomType({ id, hotelId, name, basePrice, capacity, maxAdults, maxChildren, totalRooms, }) {
    return connect_1.default.roomType.update({
        where: { id, hotelId },
        data: {
            name: name ?? "",
            basePrice,
            capacity: capacity ?? null,
            maxAdults: maxAdults ?? null,
            maxChildren: maxChildren ?? null,
            ...(totalRooms !== undefined && { totalRooms }),
        },
    });
}
async function deleteRoomType({ id, hotelId, }) {
    return connect_1.default.roomType.delete({
        where: { id, hotelId },
    });
}
//# sourceMappingURL=roomType.service.js.map