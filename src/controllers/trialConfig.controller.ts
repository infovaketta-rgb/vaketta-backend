import { Request, Response } from "express";
import { getTrialConfig, updateTrialConfig } from "../services/trialConfig.service";

// GET /admin/trial-config
export async function getTrialConfigHandler(_req: Request, res: Response) {
  try {
    const config = await getTrialConfig();
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /admin/trial-config
export async function updateTrialConfigHandler(req: Request, res: Response) {
  try {
    const { durationDays, conversationLimit, aiReplyLimit, autoStartOnCreate, trialMessage } = req.body;

    const config = await updateTrialConfig({
      ...(durationDays      != null && { durationDays:      Math.max(1, Math.min(365, Number(durationDays))) }),
      ...(conversationLimit != null && { conversationLimit: Math.max(0, Number(conversationLimit)) }),
      ...(aiReplyLimit      != null && { aiReplyLimit:      Math.max(0, Number(aiReplyLimit)) }),
      ...(autoStartOnCreate != null && { autoStartOnCreate: Boolean(autoStartOnCreate) }),
      ...(trialMessage      != null && { trialMessage:      String(trialMessage).trim() }),
    });
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
