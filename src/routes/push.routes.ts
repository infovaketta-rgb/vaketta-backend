import { Router } from "express";
import { getVapidPublicKey, subscribePush } from "../controllers/push.controller";
import { auth } from "../middleware/auth.middleware";

const router = Router();

router.get("/vapid-public-key", getVapidPublicKey);
router.post("/subscribe", auth, subscribePush);

export default router;
