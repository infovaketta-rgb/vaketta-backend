"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const hotelBilling_controller_1 = require("../controllers/hotelBilling.controller");
const settings_controller_1 = require("../controllers/settings.controller");
const flow_controller_1 = require("../controllers/flow.controller");
const availability_controller_1 = require("../controllers/availability.controller");
const router = (0, express_1.Router)();
router.get("/", settings_controller_1.getSettings);
router.patch("/", settings_controller_1.patchSettings);
router.patch("/profile", settings_controller_1.patchHotelProfile);
router.patch("/bot-messages", settings_controller_1.patchBotMessages);
router.get("/whatsapp", settings_controller_1.getWhatsAppHandler);
router.patch("/whatsapp", settings_controller_1.patchWhatsAppHandler);
router.post("/whatsapp/test", settings_controller_1.testWhatsAppHandler);
// Billing / subscription (hotel-side, JWT-protected via auth middleware in app.ts)
router.get("/billing/subscription", hotelBilling_controller_1.getSubscription);
router.get("/billing/usage", hotelBilling_controller_1.getUsage);
router.get("/billing/plans", hotelBilling_controller_1.getAvailablePlans);
router.get("/menu", settings_controller_1.getMenuHandler);
router.patch("/menu", settings_controller_1.updateMenuTitleHandler);
router.post("/menu/items", settings_controller_1.addMenuItemHandler);
router.put("/menu/items/:itemId", settings_controller_1.updateMenuItemHandler);
router.delete("/menu/items/:itemId", settings_controller_1.deleteMenuItemHandler);
// Availability calendar
router.get("/availability/calendar", availability_controller_1.getCalendarHandler);
router.patch("/availability/cell", availability_controller_1.patchCellHandler);
router.patch("/availability/bulk", availability_controller_1.bulkPatchHandler);
router.get("/availability/toggle", availability_controller_1.getToggleHandler);
router.patch("/availability/toggle", availability_controller_1.patchToggleHandler);
// Flow definitions (hotel-private + read access to global templates)
router.get("/flows", flow_controller_1.getHotelFlowsHandler);
router.post("/flows", flow_controller_1.createHotelFlowHandler);
router.get("/flows/:id", flow_controller_1.getHotelFlowHandler);
router.patch("/flows/:id", flow_controller_1.updateHotelFlowHandler);
router.delete("/flows/:id", flow_controller_1.deleteHotelFlowHandler);
exports.default = router;
//# sourceMappingURL=settings.routes.js.map