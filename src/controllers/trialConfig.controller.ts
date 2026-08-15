import { Request, Response } from "express";
import { getTrialConfig, updateTrialConfig } from "../services/trialConfig.service";
import { serverError } from "../utils/serverError";
import { parseBoolean, parseCurrency, parseIntInRange, parseLimit } from "../billing/validate";

// GET /admin/trial-config
export async function getTrialConfigHandler(_req: Request, res: Response) {
  try {
    res.json(await getTrialConfig());
  } catch (err) {
    return serverError(res, err, "Failed to load trial config");
  }
}

// PATCH /admin/trial-config
export async function updateTrialConfigHandler(req: Request, res: Response) {
  const b = req.body ?? {};
  const data: Record<string, unknown> = {};

  // Rejecting bad input beats the old silent clamping: an admin who typed
  // "1000" for a 365-day max got 365 with no indication anything was ignored.
  if (b.durationDays != null) {
    const parsed = parseIntInRange(b.durationDays, "durationDays", 1, 365);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    data.durationDays = parsed.value;
  }
  if (b.conversationLimit != null) {
    const parsed = parseLimit(b.conversationLimit, "conversationLimit");
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    data.conversationLimit = parsed.value;
  }
  if (b.aiReplyLimit != null) {
    const parsed = parseLimit(b.aiReplyLimit, "aiReplyLimit");
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    data.aiReplyLimit = parsed.value;
  }
  if (b.currency != null) {
    const parsed = parseCurrency(b.currency);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    data.currency = parsed.value;
  }
  if (b.autoStartOnCreate != null) {
    // `Boolean("false")` is true — the old code would have enabled auto-trial
    // for a client that sent the string "false".
    const parsed = parseBoolean(b.autoStartOnCreate, "autoStartOnCreate");
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    data.autoStartOnCreate = parsed.value;
  }
  if (b.trialMessage != null) {
    data.trialMessage = String(b.trialMessage).trim().slice(0, 500);
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }

  try {
    res.json(await updateTrialConfig(data));
  } catch (err) {
    return serverError(res, err, "Failed to update trial config");
  }
}
