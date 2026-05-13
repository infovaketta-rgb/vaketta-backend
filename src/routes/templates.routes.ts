import { Router, Request, Response } from "express";
import multer from "multer";
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  syncTemplate,
  parseMetaComponents,
  extractHeaderMeta,
  uploadHeaderMediaToMeta,
  reattachHeaderMediaFromSample,
} from "../services/templates.service";
import { uploadToR2 } from "../services/r2.service";
import prisma from "../db/connect";
import { decryptWhatsAppToken } from "../utils/encryption.utils";

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

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

  // Variable count must match examples and all examples must be non-empty
  const varCount = (body.components.body.text.match(/\{\{\d+\}\}/g) ?? []).length;
  const exCount  = body.components.body.examples?.length ?? 0;
  if (varCount > 0 && exCount !== varCount) {
    return `body has ${varCount} variable(s) but ${exCount} example value(s) — counts must match`;
  }
  if (varCount > 0 && (body.components.body.examples as any[]).some((e: any) => !e?.trim())) {
    return "All body variable example values must be non-empty";
  }

  // Button text must be non-empty, max 25 chars; Quick Reply labels must be unique
  for (const btn of (body.components.buttons ?? []) as any[]) {
    if (!btn.text?.trim()) return "Button label cannot be empty";
    if (btn.text.length > 25) return "Button label must be 25 characters or fewer";
    if (btn.type === "COPY_CODE" && !btn.example?.trim() && !btn.couponCode?.trim()) {
      return "Copy Code button must include an example coupon code";
    }
  }
  const qrLabels = ((body.components.buttons ?? []) as any[])
    .filter((b: any) => b.type === "QUICK_REPLY")
    .map((b: any) => b.text as string);
  if (new Set(qrLabels).size !== qrLabels.length) {
    return "Quick Reply button labels must be unique";
  }

  return null;
}

// GET /hotel-templates/approved  — convenience alias used by chat & bot flows
router.get("/approved", async (req: Request, res: Response) => {
  try {
    const templates = await getTemplates(hotelId(req), { status: "APPROVED" });
    res.json(templates);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

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
      `https://graph.facebook.com/v25.0/${wabaId}/message_templates` +
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
      const { headerFormat, headerHandle } = extractHeaderMeta(t.components ?? []);

      // DIAGNOSTIC: dump per-template what Meta returned for the HEADER component
      // and what we extracted. Remove once headerFormat/headerHandle persistence is confirmed.
      const rawHeader = Array.isArray(t.components)
        ? t.components.find((c: any) => c?.type === "HEADER")
        : null;
      console.log("[sync-from-meta] template:", t.name, "lang:", t.language);
      console.log("[sync-from-meta]   raw HEADER component:", JSON.stringify(rawHeader, null, 2));
      console.log("[sync-from-meta]   extracted headerFormat:", headerFormat, "headerHandle:", headerHandle);

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
          headerFormat,
          headerHandle,
        },
        update: {
          status:          status as any,
          metaTemplateId:  String(t.id),
          qualityScore,
          rejectionReason: t.rejected_reason ?? null,
          components,
          headerFormat,
          headerHandle,
        },
      });

      existing ? updated++ : created++;
    }

    res.json({ success: true, summary: { total: allTemplates.length, created, updated, skipped } });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /hotel-templates/upload-media — upload image/video for a template header
router.post("/upload-media", mediaUpload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const result = await uploadToR2(req.file.buffer, req.file.mimetype, { hotelId: hotelId(req) });
    res.json({ url: result.url, key: result.key });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /hotel-templates/:id/attach-header-media — upload header image/video/document
// to Meta's /media endpoint and persist the returned numeric id as headerHandle.
// Required for IMAGE/VIDEO/DOCUMENT templates: Meta rejects sends with no header
// parameter (error 132012), and scontent URLs from Meta sync aren't usable as
// image.id or image.link.
router.post("/:id/attach-header-media", mediaUpload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const result = await uploadHeaderMediaToMeta(
      hotelId(req),
      req.params["id"]!,
      req.file.buffer,
      req.file.mimetype,
    );
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message, details: err.details });
  }
});

// POST /hotel-templates/:id/reattach-header-from-sample — no file upload required.
// Server fetches the scontent sample URL Meta returned during sync, then re-uploads
// those bytes to /{phoneNumberId}/media to produce a sendable numeric handle. Use
// when the original image file isn't on hand. If the scontent URL has expired,
// re-sync the template first to refresh the signed URL.
router.post("/:id/reattach-header-from-sample", async (req: Request, res: Response) => {
  try {
    const result = await reattachHeaderMediaFromSample(hotelId(req), req.params["id"]!);
    res.json({ success: true, ...result });
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

// PATCH /hotel-templates/:id/variable-mapping  — set which context field each {{n}} maps to
router.patch("/:id/variable-mapping", async (req: Request, res: Response) => {
  try {
    const { variableMapping } = req.body;
    if (!variableMapping || typeof variableMapping !== "object" || Array.isArray(variableMapping)) {
      return res.status(400).json({ error: "variableMapping must be a plain object e.g. {\"1\":\"guest.name\"}" });
    }
    const existing = await prisma.whatsAppTemplate.findFirst({
      where: { id: req.params["id"]!, hotelId: hotelId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    const updated = await prisma.whatsAppTemplate.update({
      where: { id: req.params["id"]! },
      data:  { variableMapping },
    });
    res.json(updated);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
