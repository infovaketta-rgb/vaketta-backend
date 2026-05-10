import { Router } from "express";
import {
  getSubscription,
  getUsage,
  getAvailablePlans,
} from "../controllers/hotelBilling.controller";
import {
  getSettings,
  patchSettings,
  patchHotelProfile,
  patchBotMessages,
  getMenuHandler,
  addMenuItemHandler,
  updateMenuItemHandler,
  deleteMenuItemHandler,
  updateMenuTitleHandler,
  getWhatsAppHandler,
  patchWhatsAppHandler,
  testWhatsAppHandler,
  embeddedSignupHandler,
  getInstagramHandler,
  patchInstagramHandler,
  getIgSubscriptionStatusHandler,
  subscribeIgWebhookHandler,
  unsubscribeIgWebhookHandler,
  deleteAllChatsHandler,
} from "../controllers/settings.controller";
import {
  getHotelFlowsHandler,
  getHotelFlowHandler,
  createHotelFlowHandler,
  updateHotelFlowHandler,
  deleteHotelFlowHandler,
} from "../controllers/flow.controller";
import {
  getCalendarHandler,
  patchCellHandler,
  bulkPatchHandler,
  getToggleHandler,
  patchToggleHandler,
} from "../controllers/availability.controller";

const router = Router();

router.get("/",                     getSettings);
router.patch("/",                   patchSettings);
router.patch("/profile",            patchHotelProfile);
router.patch("/bot-messages",       patchBotMessages);

router.get("/whatsapp",             getWhatsAppHandler);
router.patch("/whatsapp",           patchWhatsAppHandler);
router.post("/whatsapp/test",             testWhatsAppHandler);
router.post("/whatsapp/embedded-signup",  embeddedSignupHandler);

router.get("/instagram",                       getInstagramHandler);
router.patch("/instagram",                     patchInstagramHandler);
router.get("/instagram/subscribe/status",      getIgSubscriptionStatusHandler);
router.post("/instagram/subscribe",            subscribeIgWebhookHandler);
router.delete("/instagram/subscribe",          unsubscribeIgWebhookHandler);

// Billing / subscription (hotel-side, JWT-protected via auth middleware in app.ts)
router.get("/billing/subscription", getSubscription);
router.get("/billing/usage",        getUsage);
router.get("/billing/plans",        getAvailablePlans);

router.get("/menu",                 getMenuHandler);
router.patch("/menu",               updateMenuTitleHandler);
router.post("/menu/items",          addMenuItemHandler);
router.put("/menu/items/:itemId",   updateMenuItemHandler);
router.delete("/menu/items/:itemId",deleteMenuItemHandler);

// Availability calendar
router.get("/availability/calendar", getCalendarHandler);
router.patch("/availability/cell",   patchCellHandler);
router.patch("/availability/bulk",   bulkPatchHandler);
router.get("/availability/toggle",   getToggleHandler);
router.patch("/availability/toggle", patchToggleHandler);

// Danger Zone
router.delete("/chats",            deleteAllChatsHandler);

// Flow definitions (hotel-private + read access to global templates)
router.get("/flows",           getHotelFlowsHandler);
router.post("/flows",          createHotelFlowHandler);
router.get("/flows/:id",       getHotelFlowHandler);
router.patch("/flows/:id",     updateHotelFlowHandler);
router.delete("/flows/:id",    deleteHotelFlowHandler);

export default router;
