import { Router, Request, Response } from "express";
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  syncTemplate,
} from "../services/templates.service";

const router = Router();

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

function validate(body: any): string | null {
  if (!body.name || typeof body.name !== "string") return "name is required";
  if (!/^[a-z0-9_]+$/.test(body.name)) return "name must be lowercase letters, numbers, and underscores only";
  if (body.name.length > 512) return "name max 512 chars";
  if (!body.language) return "language is required";
  if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(body.category)) return "category must be MARKETING, UTILITY, or AUTHENTICATION";
  if (!body.components?.body?.text) return "components.body.text is required";
  if (body.components.body.text.length > 1024) return "body text max 1024 chars";
  if (body.components.footer?.text && /\{\{/.test(body.components.footer.text)) return "footer cannot contain variables";
  if (body.category === "AUTHENTICATION" && body.components.header) return "AUTHENTICATION templates cannot have a header";
  if (body.components.buttons?.length > 10) return "maximum 10 buttons allowed";

  // Cannot mix Quick Reply + Call-to-Action buttons
  if (body.components.buttons?.length) {
    const types = new Set((body.components.buttons as any[]).map((b) => b.type));
    const hasQR  = types.has("QUICK_REPLY");
    const hasCTA = types.has("URL") || types.has("PHONE_NUMBER") || types.has("COPY_CODE");
    if (hasQR && hasCTA) return "Cannot mix Quick Reply and Call to Action buttons";
  }

  // Variable count must match examples
  const varCount = (body.components.body.text.match(/\{\{\d+\}\}/g) ?? []).length;
  const exCount  = body.components.body.examples?.length ?? 0;
  if (varCount > 0 && exCount !== varCount) {
    return `body has ${varCount} variable(s) but ${exCount} example value(s) — counts must match`;
  }

  return null;
}

// GET /hotel-templates
router.get("/", async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const status   = req.query.status   as string | undefined;
    const search   = req.query.search   as string | undefined;
    const templates = await getTemplates(hotelId(req), {
      ...(category && { category }),
      ...(status   && { status }),
      ...(search   && { search }),
    });
    res.json(templates);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /hotel-templates
router.post("/", async (req: Request, res: Response) => {
  try {
    const err = validate(req.body);
    if (err) return res.status(400).json({ error: err });
    const template = await createTemplate(hotelId(req), req.body);
    res.status(201).json(template);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.details });
  }
});

// PUT /hotel-templates/:id
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const err = validate(req.body);
    if (err) return res.status(400).json({ error: err });
    const template = await updateTemplate(hotelId(req), req.params["id"]!, req.body);
    res.json(template);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// DELETE /hotel-templates/:id
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const result = await deleteTemplate(hotelId(req), req.params["id"]!);
    res.json(result);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /hotel-templates/:id/sync
router.post("/:id/sync", async (req: Request, res: Response) => {
  try {
    const template = await syncTemplate(hotelId(req), req.params["id"]!);
    res.json(template);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
