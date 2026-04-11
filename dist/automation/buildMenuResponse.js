"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMenuMessage = buildMenuMessage;
const connect_1 = __importDefault(require("../db/connect"));
const TYPE_ICON = {
    BOOKING: "📅",
    ENQUIRY: "💬",
    INFO: "ℹ️",
    FLOW: "🔀",
};
async function buildMenuMessage(hotelId) {
    const [menu, config] = await Promise.all([
        connect_1.default.hotelMenu.findUnique({
            where: { hotelId, isActive: true },
            include: {
                hotel: { select: { name: true } },
                items: {
                    where: { isActive: true },
                    orderBy: { order: "asc" },
                },
            },
        }),
        connect_1.default.hotelConfig.findUnique({ where: { hotelId } }),
    ]);
    if (!menu || !menu.items.length)
        return null;
    const botMsgs = config?.botMessages ?? {};
    const hotelName = menu.hotel?.name;
    const defaultGreeting = hotelName ? `Welcome to *${hotelName}*! 🏨` : `Hello! 👋`;
    const greeting = botMsgs.menuGreeting?.trim() ? botMsgs.menuGreeting.trim() : defaultGreeting;
    const footer = botMsgs.menuFooter?.trim()
        ? botMsgs.menuFooter.trim()
        : `Reply with the number of your choice.\n_Type *MENU* anytime to return here._`;
    const divider = `━━━━━━━━━━━━━━━━`;
    let text = `${greeting}\n\n*${menu.title}*\n\n${divider}\n`;
    for (const item of menu.items) {
        const icon = TYPE_ICON[item.type ?? "INFO"] ?? "ℹ️";
        text += `*${item.key}.* ${item.label}  ${icon}\n`;
    }
    text += `${divider}\n\n${footer}`;
    return text;
}
//# sourceMappingURL=buildMenuResponse.js.map