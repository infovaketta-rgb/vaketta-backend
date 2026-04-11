import { Router } from "express";
import { getConversations } from "../controllers/conversation.controller";

const router = Router();

router.get("/", getConversations);

export default router;
