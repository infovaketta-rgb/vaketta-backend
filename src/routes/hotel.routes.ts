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
} from "../controllers/hotel.controller";
import { vakettaAdminAuth } from "../middleware/vakettaAdminAuth";
import {
  listPlans,
  createPlanHandler,
  updatePlanHandler,
  assignPlanHandler,
  startTrialHandler,
} from "../controllers/plan.controller";
import { getAnalytics, listHotelsWithBilling } from "../controllers/analytics.controller";
import { getTrialConfigHandler, updateTrialConfigHandler } from "../controllers/trialConfig.controller";
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

const router = Router();

// Public — Vaketta admin login
router.post("/login",  adminLogin);

// Protected — require valid Vaketta admin JWT (cookie or header)
router.post("/logout", vakettaAdminAuth, adminLogout);
router.get("/me",      vakettaAdminAuth, getMeHandler);

router.get("/hotels",        vakettaAdminAuth, listHotelsHandler);
router.post("/hotels",       vakettaAdminAuth, createHotelHandler);
router.get("/hotels/:id",    vakettaAdminAuth, getHotelHandler);
router.patch("/hotels/:id",  vakettaAdminAuth, updateHotelHandler);
router.delete("/hotels/:id", vakettaAdminAuth, deleteHotelHandler);

router.get("/admins",        vakettaAdminAuth, listAdminsHandler);
router.post("/admins",       vakettaAdminAuth, createAdminHandler);
router.delete("/admins/:id", vakettaAdminAuth, deleteAdminHandler);
router.patch("/settings",    vakettaAdminAuth, updateSettingsHandler);

// Plan management
router.get("/plans",             vakettaAdminAuth, listPlans);
router.post("/plans",            vakettaAdminAuth, createPlanHandler);
router.patch("/plans/:id",       vakettaAdminAuth, updatePlanHandler);

// Assign plan to hotel
router.patch("/hotels/:id/plan",  vakettaAdminAuth, assignPlanHandler);
// Start trial for hotel
router.post("/hotels/:id/trial",  vakettaAdminAuth, startTrialHandler);

// Analytics / MRR dashboard
router.get("/analytics",         vakettaAdminAuth, getAnalytics);
router.get("/hotels-billing",    vakettaAdminAuth, listHotelsWithBilling);

// Trial plan configuration (global defaults)
router.get("/trial-config",      vakettaAdminAuth, getTrialConfigHandler);
router.patch("/trial-config",    vakettaAdminAuth, updateTrialConfigHandler);

// Hotel user management
router.post("/hotels/:id/users",           vakettaAdminAuth, createHotelUserHandler);
router.patch("/hotels/:id/users/:userId",  vakettaAdminAuth, updateHotelUserHandler);
router.delete("/hotels/:id/users/:userId", vakettaAdminAuth, deleteHotelUserHandler);

// Privacy policy — GET is public, PATCH requires admin auth
router.get("/privacy-policy",   getPrivacyPolicyHandler);
router.patch("/privacy-policy", vakettaAdminAuth, updatePrivacyPolicyHandler);

// Flow definitions (admin-facing — full access across all flows)
router.get("/flows",        vakettaAdminAuth, adminListFlowsHandler);
router.post("/flows",       vakettaAdminAuth, adminCreateFlowHandler);
router.get("/flows/:id",    vakettaAdminAuth, adminGetFlowHandler);
router.patch("/flows/:id",  vakettaAdminAuth, adminUpdateFlowHandler);
router.delete("/flows/:id", vakettaAdminAuth, adminDeleteFlowHandler);

export default router;
