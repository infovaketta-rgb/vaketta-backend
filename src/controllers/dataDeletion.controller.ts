import { Request, Response } from "express";
import { getDataDeletion, updateDataDeletion } from "../services/dataDeletion.service";

export async function getDataDeletionHandler(_req: Request, res: Response) {
  try {
    const doc = await getDataDeletion();
    res.json(doc);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateDataDeletionHandler(req: Request, res: Response) {
  try {
    const { effectiveDate, content } = req.body;
    const doc = await updateDataDeletion({
      ...(effectiveDate != null && { effectiveDate: String(effectiveDate) }),
      ...(content       != null && { content:       String(content) }),
    });
    res.json(doc);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
