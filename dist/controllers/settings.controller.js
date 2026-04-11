"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.patchSettings = patchSettings;
exports.getMenuHandler = getMenuHandler;
exports.addMenuItemHandler = addMenuItemHandler;
exports.updateMenuItemHandler = updateMenuItemHandler;
exports.deleteMenuItemHandler = deleteMenuItemHandler;
exports.updateMenuTitleHandler = updateMenuTitleHandler;
exports.patchBotMessages = patchBotMessages;
exports.testWhatsAppHandler = testWhatsAppHandler;
exports.getWhatsAppHandler = getWhatsAppHandler;
exports.patchWhatsAppHandler = patchWhatsAppHandler;
exports.patchHotelProfile = patchHotelProfile;
const settings_service_1 = require("../services/settings.service");
function hotelId(req) {
    return req.user.hotelId;
}
async function getSettings(req, res) {
    try {
        const data = await (0, settings_service_1.getHotelSettings)(hotelId(req));
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function patchSettings(req, res) {
    try {
        const { autoReplyEnabled, bookingEnabled, bookingFlowId, businessStartHour, businessEndHour, timezone, defaultLanguage, welcomeMessage, nightMessage, } = req.body;
        const config = await (0, settings_service_1.updateHotelConfig)(hotelId(req), {
            ...(autoReplyEnabled !== undefined && { autoReplyEnabled }),
            ...(bookingEnabled !== undefined && { bookingEnabled }),
            ...(bookingFlowId !== undefined && { bookingFlowId: bookingFlowId || null }),
            ...(businessStartHour !== undefined && { businessStartHour: Number(businessStartHour) }),
            ...(businessEndHour !== undefined && { businessEndHour: Number(businessEndHour) }),
            ...(timezone !== undefined && { timezone }),
            ...(defaultLanguage !== undefined && { defaultLanguage }),
            ...(welcomeMessage !== undefined && { welcomeMessage }),
            ...(nightMessage !== undefined && { nightMessage }),
        });
        res.json(config);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function getMenuHandler(req, res) {
    try {
        res.json(await (0, settings_service_1.getMenu)(hotelId(req)));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function addMenuItemHandler(req, res) {
    try {
        const { key, label, replyText, order, type, flowId } = req.body;
        if (!key || !label) {
            return res.status(400).json({ error: "key and label are required" });
        }
        const item = await (0, settings_service_1.addMenuItem)(hotelId(req), {
            key, label, replyText: replyText ?? "", order: Number(order ?? 0), type: type ?? "INFO",
            flowId: flowId ?? null,
        });
        res.status(201).json(item);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function updateMenuItemHandler(req, res) {
    try {
        const itemId = req.params["itemId"];
        if (!itemId)
            return res.status(400).json({ error: "itemId required" });
        const item = await (0, settings_service_1.updateMenuItem)(itemId, hotelId(req), req.body);
        res.json(item);
    }
    catch (err) {
        res.status(404).json({ error: err.message });
    }
}
async function deleteMenuItemHandler(req, res) {
    try {
        const itemId = req.params["itemId"];
        if (!itemId)
            return res.status(400).json({ error: "itemId required" });
        await (0, settings_service_1.deleteMenuItem)(itemId, hotelId(req));
        res.json({ success: true });
    }
    catch (err) {
        res.status(404).json({ error: err.message });
    }
}
async function updateMenuTitleHandler(req, res) {
    try {
        const { title } = req.body;
        if (!title)
            return res.status(400).json({ error: "title is required" });
        res.json(await (0, settings_service_1.updateMenuTitle)(hotelId(req), title));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function patchBotMessages(req, res) {
    try {
        const messages = req.body;
        const config = await (0, settings_service_1.updateBotMessages)(hotelId(req), messages);
        res.json(config);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function testWhatsAppHandler(req, res) {
    try {
        const result = await (0, settings_service_1.testWhatsAppConnection)(hotelId(req));
        res.status(result.ok ? 200 : 400).json(result);
    }
    catch (err) {
        res.status(500).json({ ok: false, detail: err.message });
    }
}
async function getWhatsAppHandler(req, res) {
    try {
        res.json(await (0, settings_service_1.getWhatsAppConfig)(hotelId(req)));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function patchWhatsAppHandler(req, res) {
    try {
        const { metaPhoneNumberId, metaAccessToken, metaWabaId, metaVerifyToken } = req.body;
        await (0, settings_service_1.updateWhatsAppConfig)(hotelId(req), {
            ...(metaPhoneNumberId !== undefined && { metaPhoneNumberId }),
            ...(metaAccessToken !== undefined && { metaAccessToken }),
            ...(metaWabaId !== undefined && { metaWabaId }),
            ...(metaVerifyToken !== undefined && { metaVerifyToken }),
        });
        // Return fresh (masked) data so UI updates
        res.json(await (0, settings_service_1.getWhatsAppConfig)(hotelId(req)));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function patchHotelProfile(req, res) {
    try {
        const { name, location, email, description, checkInTime, checkOutTime, website } = req.body;
        const hotel = await (0, settings_service_1.updateHotelProfile)(hotelId(req), {
            ...(name !== undefined && { name }),
            ...(location !== undefined && { location }),
            ...(email !== undefined && { email }),
            ...(description !== undefined && { description }),
            ...(checkInTime !== undefined && { checkInTime }),
            ...(checkOutTime !== undefined && { checkOutTime }),
            ...(website !== undefined && { website }),
        });
        res.json(hotel);
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
}
//# sourceMappingURL=settings.controller.js.map