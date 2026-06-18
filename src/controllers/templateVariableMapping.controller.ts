import { Request, Response } from "express";
import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { getTemplateMappings, getHotelFlowVarNames } from "../services/templateVariableMapping.service";

const log = logger.child({ mod: "templateVariableMapping.controller" });

const VALID_SOURCE_TYPES = new Set(["BOOKING_FIELD", "FLOW_VAR"]);

// ── GET /hotel-templates/:templateId/variable-mappings ────────────────────────────
// Returns the saved mappings for one template (hotel-scoped).

export async function listTemplateVariableMappings(req: Request, res: Response) {
  try {
    const hotelId    = (req as any).user.hotelId as string;
    const templateId = String(req.params.templateId);

    const template = await prisma.whatsAppTemplate.findFirst({ where: { id: templateId, hotelId }, select: { id: true } });
    if (!template) return res.status(404).json({ error: "Template not found" });

    const mappings = await getTemplateMappings(hotelId, templateId);
    return res.json({ templateId, mappings });
  } catch (err) {
    log.error({ err }, "list template variable mappings failed");
    return res.status(500).json({ error: "Failed to load variable mappings" });
  }
}

// ── PUT /hotel-templates/:templateId/variable-mappings ────────────────────────────
// Replace-on-save: delete existing rows for the template, insert the new set, in a
// transaction. Body: { mappings: [{ variableName, sourceType, sourceKey }] }.

export async function replaceTemplateVariableMappings(req: Request, res: Response) {
  try {
    const hotelId    = (req as any).user.hotelId as string;
    const templateId = String(req.params.templateId);
    const { mappings: raw } = req.body as {
      mappings?: { variableName?: string; sourceType?: string; sourceKey?: string }[];
    };

    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "mappings must be an array" });
    }

    const template = await prisma.whatsAppTemplate.findFirst({ where: { id: templateId, hotelId }, select: { id: true } });
    if (!template) return res.status(404).json({ error: "Template not found" });

    // Validate + normalise. A blank sourceKey means "no mapping" → dropped (falls
    // through to manual input at confirm time), so we only persist complete rows.
    const rows: { hotelId: string; templateId: string; variableName: string; sourceType: string; sourceKey: string }[] = [];
    const seen = new Set<string>();
    for (const m of raw) {
      const variableName = String(m?.variableName ?? "").trim();
      const sourceType   = String(m?.sourceType ?? "").trim();
      const sourceKey    = String(m?.sourceKey ?? "").trim();
      if (!variableName) continue;
      if (!sourceKey) continue; // unmapped → no row
      if (!VALID_SOURCE_TYPES.has(sourceType)) {
        return res.status(400).json({ error: `invalid sourceType for ${variableName}: ${sourceType}` });
      }
      if (seen.has(variableName)) {
        return res.status(400).json({ error: `duplicate mapping for variable: ${variableName}` });
      }
      seen.add(variableName);
      rows.push({ hotelId, templateId, variableName, sourceType, sourceKey });
    }

    await prisma.$transaction(async (tx) => {
      await tx.templateVariableMapping.deleteMany({ where: { hotelId, templateId } });
      if (rows.length > 0) {
        await tx.templateVariableMapping.createMany({ data: rows });
      }
    });

    const mappings = await getTemplateMappings(hotelId, templateId);
    return res.json({ templateId, mappings });
  } catch (err) {
    log.error({ err }, "replace template variable mappings failed");
    return res.status(500).json({ error: "Failed to save variable mappings" });
  }
}

// ── GET /hotel-templates/flow-var-names ───────────────────────────────────────────
// Distinct flow-variable names the hotel's flows can produce — backs the FLOW_VAR
// dropdown in the mapping UI.

export async function listHotelFlowVarNames(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const names = await getHotelFlowVarNames(hotelId);
    return res.json({ names });
  } catch (err) {
    log.error({ err }, "list hotel flow var names failed");
    return res.status(500).json({ error: "Failed to load flow variable names" });
  }
}
