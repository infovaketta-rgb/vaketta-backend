import { Router } from "express";
import { submitLead, listLeads, updateLead, listPublicPlans } from "../controllers/lead.controller";
import { vakettaAdminAuth } from "../middleware/vakettaAdminAuth";

// Public routes  — mounted at /public
export const publicRouter = Router();
publicRouter.post("/leads",  submitLead);
publicRouter.get("/plans",   listPublicPlans);

// Admin routes — mounted at /admin (already protected by vakettaAdminAuth in hotel.routes or app.ts)
export const adminLeadRouter = Router();
adminLeadRouter.get("/",      vakettaAdminAuth, listLeads);
adminLeadRouter.patch("/:id", vakettaAdminAuth, updateLead);
