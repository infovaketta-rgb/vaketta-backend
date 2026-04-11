"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const hotel_controller_1 = require("../controllers/hotel.controller");
const vakettaAdminAuth_1 = require("../middleware/vakettaAdminAuth");
const plan_controller_1 = require("../controllers/plan.controller");
const analytics_controller_1 = require("../controllers/analytics.controller");
const trialConfig_controller_1 = require("../controllers/trialConfig.controller");
const flow_controller_1 = require("../controllers/flow.controller");
const router = (0, express_1.Router)();
// Public — Vaketta admin login
router.post("/login", hotel_controller_1.adminLogin);
// Protected — require valid Vaketta admin JWT (cookie or header)
router.post("/logout", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.adminLogout);
router.get("/me", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.getMeHandler);
router.get("/hotels", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.listHotelsHandler);
router.post("/hotels", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.createHotelHandler);
router.get("/hotels/:id", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.getHotelHandler);
router.patch("/hotels/:id", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.updateHotelHandler);
router.delete("/hotels/:id", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.deleteHotelHandler);
router.get("/admins", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.listAdminsHandler);
router.post("/admins", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.createAdminHandler);
router.delete("/admins/:id", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.deleteAdminHandler);
router.patch("/settings", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.updateSettingsHandler);
// Plan management
router.get("/plans", vakettaAdminAuth_1.vakettaAdminAuth, plan_controller_1.listPlans);
router.post("/plans", vakettaAdminAuth_1.vakettaAdminAuth, plan_controller_1.createPlanHandler);
router.patch("/plans/:id", vakettaAdminAuth_1.vakettaAdminAuth, plan_controller_1.updatePlanHandler);
// Assign plan to hotel
router.patch("/hotels/:id/plan", vakettaAdminAuth_1.vakettaAdminAuth, plan_controller_1.assignPlanHandler);
// Start trial for hotel
router.post("/hotels/:id/trial", vakettaAdminAuth_1.vakettaAdminAuth, plan_controller_1.startTrialHandler);
// Analytics / MRR dashboard
router.get("/analytics", vakettaAdminAuth_1.vakettaAdminAuth, analytics_controller_1.getAnalytics);
router.get("/hotels-billing", vakettaAdminAuth_1.vakettaAdminAuth, analytics_controller_1.listHotelsWithBilling);
// Trial plan configuration (global defaults)
router.get("/trial-config", vakettaAdminAuth_1.vakettaAdminAuth, trialConfig_controller_1.getTrialConfigHandler);
router.patch("/trial-config", vakettaAdminAuth_1.vakettaAdminAuth, trialConfig_controller_1.updateTrialConfigHandler);
// Hotel user management
router.post("/hotels/:id/users", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.createHotelUserHandler);
router.patch("/hotels/:id/users/:userId", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.updateHotelUserHandler);
router.delete("/hotels/:id/users/:userId", vakettaAdminAuth_1.vakettaAdminAuth, hotel_controller_1.deleteHotelUserHandler);
// Flow definitions (admin-facing — full access across all flows)
router.get("/flows", vakettaAdminAuth_1.vakettaAdminAuth, flow_controller_1.adminListFlowsHandler);
router.post("/flows", vakettaAdminAuth_1.vakettaAdminAuth, flow_controller_1.adminCreateFlowHandler);
router.get("/flows/:id", vakettaAdminAuth_1.vakettaAdminAuth, flow_controller_1.adminGetFlowHandler);
router.patch("/flows/:id", vakettaAdminAuth_1.vakettaAdminAuth, flow_controller_1.adminUpdateFlowHandler);
router.delete("/flows/:id", vakettaAdminAuth_1.vakettaAdminAuth, flow_controller_1.adminDeleteFlowHandler);
exports.default = router;
//# sourceMappingURL=hotel.routes.js.map