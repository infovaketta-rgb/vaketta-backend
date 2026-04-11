"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHotel = createHotel;
const connect_1 = __importDefault(require("../db/connect"));
const crypto_1 = __importDefault(require("crypto"));
async function createHotel(name, phone) {
    const apiKey = crypto_1.default.randomBytes(32).toString("hex"); // unique per hotel, per call
    const hotel = await connect_1.default.hotel.create({
        data: {
            name,
            phone,
            apiKey,
            config: {
                create: {
                    autoReplyEnabled: true,
                    bookingEnabled: true,
                },
            },
        },
        include: {
            config: true,
        },
    });
    return hotel;
}
//# sourceMappingURL=hotel.service.js.map