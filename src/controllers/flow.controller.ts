import { Request, Response } from "express";
import {
  getHotelFlows, getHotelFlow, createHotelFlow, updateHotelFlow, deleteHotelFlow,
  getAllFlows, getAdminFlow, createAdminFlow, updateAdminFlow, deleteAdminFlow,
  saveDraft, publishDraft, rollbackToVersion, listVersions,
} from "../services/flow.service";

// ── Hotel-facing handlers ─────────────────────────────────────────────────────

export async function getHotelFlowsHandler(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const flows = await getHotelFlows(hotelId);
    res.json(flows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function getHotelFlowHandler(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const flow = await getHotelFlow(req.params["id"]!, hotelId);
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    res.json(flow);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function createHotelFlowHandler(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const { name, description, nodes, edges } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const flow = await createHotelFlow(hotelId, { name, description, nodes, edges });
    res.status(201).json(flow);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateHotelFlowHandler(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const { name, description, nodes, edges, isActive } = req.body;
    const flow = await updateHotelFlow(req.params["id"]!, hotelId, { name, description, nodes, edges, isActive });
    res.json(flow);
  } catch (err: any) {
    const status = err.message.includes("access denied") ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
}

export async function deleteHotelFlowHandler(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    await deleteHotelFlow(req.params["id"]!, hotelId);
    res.json({ success: true });
  } catch (err: any) {
    const status = err.message.includes("access denied") ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
}

// ── Versioning handlers ───────────────────────────────────────────────────────

export async function saveDraftHandler(req: Request, res: Response) {
  try {
    const hotelId  = (req as any).user.hotelId as string;
    const userName = (req as any).user.name   as string | undefined;
    const { name, nodes, edges } = req.body;
    const flow = await saveDraft(req.params["id"]!, hotelId, { name, nodes, edges, ...(userName && { userName }) });
    res.json(flow);
  } catch (err: any) {
    const status = err.message.includes("access denied") ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
}

export async function publishDraftHandler(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const flow = await publishDraft(req.params["id"]!, hotelId);
    res.json(flow);
  } catch (err: any) {
    const status = err.message.includes("access denied") ? 403
      : err.message.includes("No draft") ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
}

export async function rollbackToVersionHandler(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const flow = await rollbackToVersion(req.params["id"]!, hotelId, req.params["versionId"]!);
    res.json(flow);
  } catch (err: any) {
    const status = err.message.includes("access denied") ? 403
      : err.message.includes("not found") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
}

export async function listVersionsHandler(req: Request, res: Response) {
  try {
    const hotelId  = (req as any).user.hotelId as string;
    const versions = await listVersions(req.params["id"]!, hotelId);
    res.json(versions);
  } catch (err: any) {
    const status = err.message.includes("access denied") ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
}

// ── Admin-facing handlers ─────────────────────────────────────────────────────

export async function adminListFlowsHandler(req: Request, res: Response) {
  try {
    const isTemplate = req.query["isTemplate"] !== undefined
      ? req.query["isTemplate"] === "true"
      : undefined;
    const hotelId = req.query["hotelId"] as string | undefined;
    const flows = await getAllFlows({
      ...(isTemplate !== undefined && { isTemplate }),
      ...(hotelId !== undefined && { hotelId: hotelId === "null" ? null : hotelId }),
    });
    res.json(flows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminGetFlowHandler(req: Request, res: Response) {
  try {
    const flow = await getAdminFlow(req.params["id"]!);
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    res.json(flow);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminCreateFlowHandler(req: Request, res: Response) {
  try {
    const { name, description, nodes, edges, isTemplate, hotelId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const flow = await createAdminFlow({
      name, description, nodes, edges,
      isTemplate: Boolean(isTemplate),
      hotelId: hotelId ?? null,
    });
    res.status(201).json(flow);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminUpdateFlowHandler(req: Request, res: Response) {
  try {
    const { name, description, nodes, edges, isActive, isTemplate, hotelId } = req.body;
    const flow = await updateAdminFlow(req.params["id"]!, {
      name, description, nodes, edges, isActive, isTemplate,
      ...(hotelId !== undefined && { hotelId: hotelId === null ? null : hotelId }),
    });
    res.json(flow);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminDeleteFlowHandler(req: Request, res: Response) {
  try {
    await deleteAdminFlow(req.params["id"]!);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
