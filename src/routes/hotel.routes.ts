import { Router } from "express";
import {
  adminLogin,
  adminLogout,
  getMeHandler,
  createHotelHandler,
  listHotelsHandler,
  getHotelHandler,
  updateHotelHandler,
  deleteHotelHandler,
  listAdminsHandler,
  createAdminHandler,
  deleteAdminHandler,
  updateSettingsHandler,
  createHotelUserHandler,
  updateHotelUserHandler,
  deleteHotelUserHandler,
  getAdminSocketToken,
} from "../controllers/hotel.controller";
import { vakettaAdminAuth } from "../middleware/vakettaAdminAuth";
import {
  listPlans,
  createPlanHandler,
  updatePlanHandler,
  assignPlanHandler,
  startTrialHandler,
  cancelSubscriptionHandler,
  extendSubscriptionHandler,
} from "../controllers/plan.controller";
import { requireBillingAdmin, requireSuperAdmin } from "../middleware/requireVakettaRole";
import {
  listInvoicesHandler,
  recordPaymentHandler,
  voidInvoiceHandler,
  listAuditLogHandler,
} from "../controllers/adminBilling.controller";
import { getAnalytics, listHotelsWithBilling } from "../controllers/analytics.controller";
import { getTrialConfigHandler, updateTrialConfigHandler } from "../controllers/trialConfig.controller";
import { getPlatformSettingsHandler, patchPlatformSettingsHandler, setHotelMaxStayHandler } from "../controllers/settings.controller";
import {
  adminListFlowsHandler,
  adminGetFlowHandler,
  adminCreateFlowHandler,
  adminUpdateFlowHandler,
  adminDeleteFlowHandler,
} from "../controllers/flow.controller";
import {
  getPrivacyPolicyHandler,
  updatePrivacyPolicyHandler,
} from "../controllers/privacyPolicy.controller";
import {
  getTermsOfServiceHandler,
  updateTermsOfServiceHandler,
} from "../controllers/termsOfService.controller";
import {
  getDataDeletionHandler,
  updateDataDeletionHandler,
} from "../controllers/dataDeletion.controller";

const router = Router();

// Public — Vaketta admin login
router.post("/login",  adminLogin);

// Protected — require valid Vaketta admin JWT (cookie or header)
router.post("/logout",       vakettaAdminAuth, adminLogout);
router.get("/me",            vakettaAdminAuth, getMeHandler);
router.get("/socket-token",  vakettaAdminAuth, getAdminSocketToken);

router.get("/hotels",        vakettaAdminAuth, listHotelsHandler);
router.post("/hotels",       vakettaAdminAuth, createHotelHandler);
router.get("/hotels/:id",    vakettaAdminAuth, getHotelHandler);
router.patch("/hotels/:id",  vakettaAdminAuth, updateHotelHandler);
router.delete("/hotels/:id", vakettaAdminAuth, deleteHotelHandler);

router.get("/admins",        vakettaAdminAuth, listAdminsHandler);
router.post("/admins",       vakettaAdminAuth, createAdminHandler);
router.delete("/admins/:id", vakettaAdminAuth, deleteAdminHandler);
router.patch("/settings",    vakettaAdminAuth, updateSettingsHandler);

// ── Billing ───────────────────────────────────────────────────────────────────
// Reads are open to any authenticated Vaketta admin (SUPPORT included — they
// need to answer "what plan is this hotel on?"). WRITES require a billing role:
// `vakettaAdminAuth` never checked VakettaAdminRole, so a SUPPORT admin could
// rewrite prices and grant free trials.

// Plan management
router.get("/plans",             vakettaAdminAuth, listPlans);
router.post("/plans",            vakettaAdminAuth, requireBillingAdmin, createPlanHandler);
router.patch("/plans/:id",       vakettaAdminAuth, requireBillingAdmin, updatePlanHandler);

// Subscription lifecycle for a hotel
router.patch("/hotels/:id/plan",   vakettaAdminAuth, requireBillingAdmin, assignPlanHandler);
router.post("/hotels/:id/trial",   vakettaAdminAuth, requireBillingAdmin, startTrialHandler);
router.post("/hotels/:id/cancel",  vakettaAdminAuth, requireBillingAdmin, cancelSubscriptionHandler);
router.post("/hotels/:id/extend",  vakettaAdminAuth, requireBillingAdmin, extendSubscriptionHandler);
// Superadmin sets a hotel's max-stay override (clamped to platform ceiling)
router.patch("/hotels/:hotelId/max-stay", vakettaAdminAuth, requireBillingAdmin, setHotelMaxStayHandler);

// Invoices & payments
router.get("/invoices",                 vakettaAdminAuth, listInvoicesHandler);
router.post("/invoices/:id/payments",   vakettaAdminAuth, requireBillingAdmin, recordPaymentHandler);
router.post("/invoices/:id/void",       vakettaAdminAuth, requireBillingAdmin, voidInvoiceHandler);

// Audit trail
router.get("/audit-log",         vakettaAdminAuth, listAuditLogHandler);

// Analytics / MRR dashboard
router.get("/analytics",         vakettaAdminAuth, getAnalytics);
router.get("/hotels-billing",    vakettaAdminAuth, listHotelsWithBilling);

// Trial plan configuration (global defaults)
router.get("/trial-config",      vakettaAdminAuth, getTrialConfigHandler);
router.patch("/trial-config",    vakettaAdminAuth, requireBillingAdmin, updateTrialConfigHandler);

// Platform-wide settings (Instagram embed URL, billing timezone, grace period…)
router.get("/platform-settings",   vakettaAdminAuth, getPlatformSettingsHandler);
router.patch("/platform-settings", vakettaAdminAuth, requireSuperAdmin, patchPlatformSettingsHandler);

// Hotel user management
router.post("/hotels/:id/users",           vakettaAdminAuth, createHotelUserHandler);
router.patch("/hotels/:id/users/:userId",  vakettaAdminAuth, updateHotelUserHandler);
router.delete("/hotels/:id/users/:userId", vakettaAdminAuth, deleteHotelUserHandler);

// Privacy policy — GET is public, PATCH requires admin auth
router.get("/privacy-policy",   getPrivacyPolicyHandler);
router.patch("/privacy-policy", vakettaAdminAuth, updatePrivacyPolicyHandler);

// Terms of service — GET is public, PATCH requires admin auth
router.get("/terms-of-service",   getTermsOfServiceHandler);
router.patch("/terms-of-service", vakettaAdminAuth, updateTermsOfServiceHandler);

// Data deletion — GET is public, PATCH requires admin auth
router.get("/data-deletion",   getDataDeletionHandler);
router.patch("/data-deletion", vakettaAdminAuth, updateDataDeletionHandler);

// Flow definitions (admin-facing — full access across all flows)
router.get("/flows",        vakettaAdminAuth, adminListFlowsHandler);
router.post("/flows",       vakettaAdminAuth, adminCreateFlowHandler);
router.get("/flows/:id",    vakettaAdminAuth, adminGetFlowHandler);
router.patch("/flows/:id",  vakettaAdminAuth, adminUpdateFlowHandler);
router.delete("/flows/:id", vakettaAdminAuth, adminDeleteFlowHandler);

export default router;
