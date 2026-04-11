import { Router } from "express";
import { handleWhatsAppWebhook, verifyWhatsAppWebhook } from "../controllers/whatsapp.controller";

const router = Router();

// Bug 1: Meta requires a GET endpoint to verify the webhook during setup
router.get("/", verifyWhatsAppWebhook);
router.post("/", handleWhatsAppWebhook);

export default router;
