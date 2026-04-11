"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveMenuSelection = resolveMenuSelection;
const connect_1 = __importDefault(require("../db/connect"));
async function resolveMenuSelection(hotelId, input) {
    if (!input)
        return null;
    const key = input.trim().toUpperCase();
    const item = await connect_1.default.hotelMenuItem.findFirst({
        where: {
            key,
            isActive: true,
            menu: {
                hotelId,
                isActive: true,
            },
        },
    });
    return item?.replyText ?? null;
}
//# sourceMappingURL=resolveMenuSelection.js.map