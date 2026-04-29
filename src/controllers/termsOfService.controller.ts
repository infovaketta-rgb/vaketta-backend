import { Request, Response } from "express";
import { getTermsOfService, updateTermsOfService } from "../services/termsOfService.service";
import { serverError } from "../utils/serverError";

export async function getTermsOfServiceHandler(_req: Request, res: Response) {
  try {
    const doc = await getTermsOfService();
    res.json(doc);
  } catch (err) {
    serverError(res, err);
  }
}

export async function updateTermsOfServiceHandler(req: Request, res: Response) {
  try {
    const { effectiveDate, content } = req.body;
    const doc = await updateTermsOfService({
      ...(effectiveDate != null && { effectiveDate: String(effectiveDate) }),
      ...(content       != null && { content:       String(content) }),
    });
    res.json(doc);
  } catch (err) {
    serverError(res, err);
  }
}
