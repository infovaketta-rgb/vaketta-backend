import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { submitLead, listLeads, updateLead, listPublicPlans } from "../controllers/lead.controller";
import { vakettaAdminAuth } from "../middleware/vakettaAdminAuth";

const leadSubmitLimiter = rateLimit({
  windowMs:        10 * 60 * 1000, // 10 min
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many submissions. Please try again later." },
});

// Public routes  — mounted at /public
export const publicRouter = Router();
publicRouter.post("/leads",  leadSubmitLimiter, submitLead);
publicRouter.get("/plans",   listPublicPlans);

// Admin routes — mounted at /admin (already protected by vakettaAdminAuth in hotel.routes or app.ts)
export const adminLeadRouter = Router();
adminLeadRouter.get("/",      vakettaAdminAuth, listLeads);
adminLeadRouter.patch("/:id", vakettaAdminAuth, updateLead);
