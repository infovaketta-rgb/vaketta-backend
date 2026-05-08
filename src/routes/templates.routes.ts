import { Router, Request, Response } from "express";
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  syncTemplate,
  parseMetaComponents,
} from "../services/templates.service";
import prisma from "../db/connect";
import { decryptWhatsAppToken } from "../utils/encryption.utils";

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

// POST /hotel-templates/sync-from-meta  — import all templates from Meta WABA
router.post("/sync-from-meta", async (req: Request, res: Response) => {
  try {
    const hid = hotelId(req);

    const config = await prisma.hotelConfig.findUnique({ where: { hotelId: hid } });
    if (!config?.metaWabaId || !config?.metaAccessTokenEncrypted) {
      return res.status(400).json({ error: "WhatsApp is not configured for this hotel" });
    }
    const accessToken = decryptWhatsAppToken(config.metaAccessTokenEncrypted);
    const wabaId      = config.metaWabaId;

    // Meta status → internal status
    const STATUS_MAP: Record<string, string> = {
      APPROVED:  "APPROVED",
      ACTIVE:    "APPROVED",
      PENDING:   "PENDING",
      IN_APPEAL: "PENDING",
      REJECTED:  "REJECTED",
      PAUSED:    "PAUSED",
      DISABLED:  "DISABLED",
      DELETED:   "DISABLED",
    };

    // Recognised categories
    const VALID_CATEGORIES = new Set(["MARKETING", "UTILITY", "AUTHENTICATION"]);

    // Fetch all pages from Meta
    const allTemplates: any[] = [];
    let url: string | null =
      `https://graph.facebook.com/v23.0/${wabaId}/message_templates` +
      `?limit=100&fields=id,name,language,category,status,quality_score,components,rejected_reason`;

    while (url) {
      const metaRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data    = await metaRes.json() as any;
      if (!metaRes.ok) {
        return res.status(400).json({ error: data?.error?.message ?? "Meta API error", details: data?.error });
      }
      allTemplates.push(...(data.data ?? []));
      url = data.paging?.next ?? null;
    }

    let created = 0, updated = 0, skipped = 0;

    for (const t of allTemplates) {
      const category = t.category as string;
      if (!VALID_CATEGORIES.has(category)) { skipped++; continue; }

      const status      = STATUS_MAP[t.status as string] ?? "PENDING";
      const score       = t.quality_score?.score;
      const qualityScore = (score === "GREEN" || score === "YELLOW" || score === "RED")
        ? score
        : score ? "UNKNOWN" : null;

      const components = parseMetaComponents(t.components ?? []);

      const existing = await prisma.whatsAppTemplate.findUnique({
        where: { hotelId_name_language: { hotelId: hid, name: t.name, language: t.language } },
      });

      await prisma.whatsAppTemplate.upsert({
        where: { hotelId_name_language: { hotelId: hid, name: t.name, language: t.language } },
        create: {
          hotelId:          hid,
          name:             t.name,
          language:         t.language,
          category:         category as any,
          status:           status   as any,
          metaTemplateId:   String(t.id),
          qualityScore,
          rejectionReason:  t.rejected_reason ?? null,
          components,
        },
        update: {
          status:          status as any,
          metaTemplateId:  String(t.id),
          qualityScore,
          rejectionReason: t.rejected_reason ?? null,
          components,
        },
      });

      existing ? updated++ : created++;
    }

    res.json({ success: true, summary: { total: allTemplates.length, created, updated, skipped } });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
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
