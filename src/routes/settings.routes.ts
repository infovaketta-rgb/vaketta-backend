import { Router } from "express";
import {
  getSubscription,
  getUsage,
  getAvailablePlans,
  getInvoices,
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
  resyncWhatsAppHistoryHandler,
  getInstagramHandler,
  patchInstagramHandler,
  deleteAllChatsHandler,
} from "../controllers/settings.controller";
import {
  getHotelFlowsHandler,
  getHotelFlowHandler,
  createHotelFlowHandler,
  updateHotelFlowHandler,
  deleteHotelFlowHandler,
  saveDraftHandler,
  publishDraftHandler,
  rollbackToVersionHandler,
  listVersionsHandler,
} from "../controllers/flow.controller";
import {
  getCalendarHandler,
  patchCellHandler,
  bulkPatchHandler,
  getToggleHandler,
  patchToggleHandler,
} from "../controllers/availability.controller";
import { requireBillingViewer } from "../middleware/requireHotelRole";

const router = Router();

router.get("/",                     getSettings);
router.patch("/",                   patchSettings);
router.patch("/profile",            patchHotelProfile);
router.patch("/bot-messages",       patchBotMessages);

router.get("/whatsapp",             getWhatsAppHandler);
router.patch("/whatsapp",           patchWhatsAppHandler);
router.post("/whatsapp/test",             testWhatsAppHandler);
router.post("/whatsapp/embedded-signup",  embeddedSignupHandler);
router.post("/whatsapp/resync-history",   resyncWhatsAppHistoryHandler);

router.get("/instagram",                       getInstagramHandler);
router.patch("/instagram",                     patchInstagramHandler);

// Billing / subscription (hotel-side, JWT-protected via auth middleware in app.ts)
//
// OWNER/ADMIN only. These expose what the hotel pays, owes and has been
// invoiced; MANAGER and STAFF have no need for the commercial relationship and
// previously could read all of it. `hotelId` still comes from the JWT in every
// handler, so this narrows access within a hotel and cannot widen it across
// hotels. Mounted BEFORE the handlers so no billing route can escape the gate.
router.get("/billing/subscription", requireBillingViewer, getSubscription);
router.get("/billing/usage",        requireBillingViewer, getUsage);
router.get("/billing/plans",        requireBillingViewer, getAvailablePlans);
router.get("/billing/invoices",     requireBillingViewer, getInvoices);

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
router.get("/flows",                               getHotelFlowsHandler);
router.post("/flows",                              createHotelFlowHandler);
router.get("/flows/:id",                           getHotelFlowHandler);
router.patch("/flows/:id",                         updateHotelFlowHandler);
router.delete("/flows/:id",                        deleteHotelFlowHandler);
// Versioning
router.post("/flows/:id/draft",                    saveDraftHandler);
router.post("/flows/:id/publish",                  publishDraftHandler);
router.get("/flows/:id/versions",                  listVersionsHandler);
router.post("/flows/:id/rollback/:versionId",      rollbackToVersionHandler);

export default router;
