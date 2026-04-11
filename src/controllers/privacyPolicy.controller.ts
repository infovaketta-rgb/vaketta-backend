import { Request, Response } from "express";
import { getPrivacyPolicy, updatePrivacyPolicy } from "../services/privacyPolicy.service";

// GET /admin/privacy-policy  (public — no auth required)
export async function getPrivacyPolicyHandler(_req: Request, res: Response) {
  try {
    const policy = await getPrivacyPolicy();
    res.json(policy);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /admin/privacy-policy  (admin auth required)
export async function updatePrivacyPolicyHandler(req: Request, res: Response) {
  try {
    const { effectiveDate, content } = req.body;
    const policy = await updatePrivacyPolicy({
      ...(effectiveDate != null && { effectiveDate: String(effectiveDate) }),
      ...(content       != null && { content:       String(content) }),
    });
    res.json(policy);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
