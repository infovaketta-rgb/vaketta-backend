import prisma from "../db/connect";
import { SerializedFlowNode, SerializedFlowEdge } from "../automation/flowTypes";

// ── DTOs ──────────────────────────────────────────────────────────────────────

interface FlowCreateDto {
  name:        string;
  description?: string;
  nodes?:       SerializedFlowNode[];
  edges?:       SerializedFlowEdge[];
  isTemplate?:  boolean;
}

interface FlowUpdateDto {
  name?:        string;
  description?: string;
  nodes?:       SerializedFlowNode[];
  edges?:       SerializedFlowEdge[];
  isActive?:    boolean;
  isTemplate?:  boolean;
}

// ── Hotel-facing (hotel-private flows + read access to global templates) ───────

/** Returns hotel-private flows + global templates (for the flow picker) */
export async function getHotelFlows(hotelId: string) {
  return prisma.flowDefinition.findMany({
    where: {
      OR: [{ hotelId }, { isTemplate: true }],
    },
    orderBy: [{ isTemplate: "asc" }, { createdAt: "desc" }],
    select: {
      id: true, hotelId: true, name: true, description: true,
      isActive: true, isTemplate: true, createdAt: true, updatedAt: true,
    },
  });
}

/** Get a single flow — must belong to hotel OR be a global template */
export async function getHotelFlow(id: string, hotelId: string) {
  const flow = await prisma.flowDefinition.findUnique({ where: { id } });
  if (!flow) return null;
  if (flow.hotelId !== hotelId && !flow.isTemplate) return null;
  return flow;
}

/** Create a hotel-private flow */
export async function createHotelFlow(hotelId: string, dto: FlowCreateDto) {
  return prisma.flowDefinition.create({
    data: {
      hotelId,
      name:        dto.name,
      description: dto.description ?? null,
      nodes:       (dto.nodes ?? []) as any,
      edges:       (dto.edges ?? []) as any,
      isTemplate:  false,
    },
  });
}

/** Update a hotel-private flow (hotel must own it — cannot edit templates) */
export async function updateHotelFlow(id: string, hotelId: string, dto: FlowUpdateDto) {
  const flow = await prisma.flowDefinition.findUnique({ where: { id } });
  if (!flow || flow.hotelId !== hotelId) throw new Error("Flow not found or access denied");
  return prisma.flowDefinition.update({
    where: { id },
    data: {
      ...(dto.name        !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.nodes       !== undefined && { nodes: dto.nodes as any }),
      ...(dto.edges       !== undefined && { edges: dto.edges as any }),
      ...(dto.isActive    !== undefined && { isActive: dto.isActive }),
    },
  });
}

/** Delete a hotel-private flow */
export async function deleteHotelFlow(id: string, hotelId: string) {
  const flow = await prisma.flowDefinition.findUnique({ where: { id } });
  if (!flow || flow.hotelId !== hotelId) throw new Error("Flow not found or access denied");
  return prisma.flowDefinition.delete({ where: { id } });
}

// ── Admin-facing (full access across all flows) ────────────────────────────────

export async function getAllFlows(filter?: { isTemplate?: boolean; hotelId?: string | null }) {
  return prisma.flowDefinition.findMany({
    where: {
      ...(filter?.isTemplate !== undefined && { isTemplate: filter.isTemplate }),
      ...(filter?.hotelId !== undefined && { hotelId: filter.hotelId }),
    },
    orderBy: [{ isTemplate: "desc" }, { createdAt: "desc" }],
    include: { hotel: { select: { id: true, name: true } } },
  });
}

export async function getAdminFlow(id: string) {
  return prisma.flowDefinition.findUnique({
    where: { id },
    include: { hotel: { select: { id: true, name: true } } },
  });
}

/** Admin creates a flow — can be global template (hotelId=null, isTemplate=true) or per-hotel */
export async function createAdminFlow(dto: FlowCreateDto & { hotelId?: string | null }) {
  return prisma.flowDefinition.create({
    data: {
      hotelId:     dto.hotelId ?? null,
      name:        dto.name,
      description: dto.description ?? null,
      nodes:       (dto.nodes ?? []) as any,
      edges:       (dto.edges ?? []) as any,
      isTemplate:  dto.isTemplate ?? false,
    },
    include: { hotel: { select: { id: true, name: true } } },
  });
}

export async function updateAdminFlow(id: string, dto: FlowUpdateDto & { hotelId?: string | null }) {
  return prisma.flowDefinition.update({
    where: { id },
    data: {
      ...(dto.name        !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.nodes       !== undefined && { nodes: dto.nodes as any }),
      ...(dto.edges       !== undefined && { edges: dto.edges as any }),
      ...(dto.isActive    !== undefined && { isActive: dto.isActive }),
      ...(dto.isTemplate  !== undefined && { isTemplate: dto.isTemplate }),
      ...(dto.hotelId     !== undefined && { hotelId: dto.hotelId }),
    },
    include: { hotel: { select: { id: true, name: true } } },
  });
}

export async function deleteAdminFlow(id: string) {
  return prisma.flowDefinition.delete({ where: { id } });
}

// ── Versioning ────────────────────────────────────────────────────────────────

interface SaveDraftDto {
  name?:     string;
  nodes:     SerializedFlowNode[];
  edges:     SerializedFlowEdge[];
  userName?: string;
}

/** Save canvas state as the current DRAFT version. Creates a new FlowVersion record
 *  the first time; thereafter overwrites the existing DRAFT record. */
export async function saveDraft(id: string, hotelId: string, dto: SaveDraftDto) {
  const flow = await prisma.flowDefinition.findUnique({ where: { id } });
  if (!flow || flow.hotelId !== hotelId) throw new Error("Flow not found or access denied");

  const nameUpdate = dto.name !== undefined ? { name: dto.name } : {};

  // Reuse existing DRAFT version if one already exists
  if (flow.draftVersionId) {
    const existing = await prisma.flowVersion.findUnique({ where: { id: flow.draftVersionId } });
    if (existing && existing.status === "DRAFT") {
      await prisma.flowVersion.update({
        where: { id: flow.draftVersionId },
        data: { nodes: dto.nodes as any, edges: dto.edges as any },
      });
      return prisma.flowDefinition.update({
        where: { id },
        data: { ...nameUpdate, nodes: dto.nodes as any, edges: dto.edges as any },
      });
    }
  }

  // Create a fresh DRAFT version
  const last = await prisma.flowVersion.findFirst({
    where: { flowId: id },
    orderBy: { versionNumber: "desc" },
  });
  const nextNumber = (last?.versionNumber ?? 0) + 1;

  const draft = await prisma.flowVersion.create({
    data: {
      flowId: id,
      versionNumber: nextNumber,
      nodes: dto.nodes as any,
      edges: dto.edges as any,
      status: "DRAFT",
      createdBy: dto.userName ?? null,
    },
  });

  return prisma.flowDefinition.update({
    where: { id },
    data: {
      ...nameUpdate,
      draftVersionId: draft.id,
      nodes: dto.nodes as any,
      edges: dto.edges as any,
    },
  });
}

/** Promote the current DRAFT to PUBLISHED. Archives the previous PUBLISHED version. */
export async function publishDraft(id: string, hotelId: string) {
  const flow = await prisma.flowDefinition.findUnique({ where: { id } });
  if (!flow || flow.hotelId !== hotelId) throw new Error("Flow not found or access denied");
  if (!flow.draftVersionId) throw new Error("No draft to publish");

  return prisma.$transaction(async (tx) => {
    if (flow.publishedVersionId) {
      await tx.flowVersion.update({
        where: { id: flow.publishedVersionId },
        data: { status: "ARCHIVED" },
      });
    }

    const published = await tx.flowVersion.update({
      where: { id: flow.draftVersionId! },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });

    return tx.flowDefinition.update({
      where: { id },
      data: {
        publishedVersionId: published.id,
        draftVersionId: null,
        nodes: published.nodes as any,
        edges: published.edges as any,
      },
    });
  });
}

/** Create a new DRAFT from an ARCHIVED version (rollback). */
export async function rollbackToVersion(id: string, hotelId: string, versionId: string) {
  const flow = await prisma.flowDefinition.findUnique({ where: { id } });
  if (!flow || flow.hotelId !== hotelId) throw new Error("Flow not found or access denied");

  const version = await prisma.flowVersion.findUnique({ where: { id: versionId } });
  if (!version || version.flowId !== id) throw new Error("Version not found");

  const last = await prisma.flowVersion.findFirst({
    where: { flowId: id },
    orderBy: { versionNumber: "desc" },
  });
  const nextNumber = (last?.versionNumber ?? 0) + 1;

  const draft = await prisma.flowVersion.create({
    data: {
      flowId: id,
      versionNumber: nextNumber,
      nodes: version.nodes as any,
      edges: version.edges as any,
      status: "DRAFT",
    },
  });

  return prisma.flowDefinition.update({
    where: { id },
    data: {
      draftVersionId: draft.id,
      nodes: version.nodes as any,
      edges: version.edges as any,
    },
  });
}

/** Return all versions for a flow in descending order. */
export async function listVersions(id: string, hotelId: string) {
  const flow = await prisma.flowDefinition.findUnique({ where: { id } });
  if (!flow || (flow.hotelId !== hotelId && !flow.isTemplate)) {
    throw new Error("Flow not found or access denied");
  }
  return prisma.flowVersion.findMany({
    where: { flowId: id },
    orderBy: { versionNumber: "desc" },
  });
}

/** Load nodes+edges for runtime execution. Prefers the published version;
 *  falls back to the legacy FlowDefinition.nodes/edges for pre-versioning flows. */
export async function getPublishedNodes(
  flowId: string
): Promise<{ nodes: SerializedFlowNode[]; edges: SerializedFlowEdge[] } | null> {
  const flow = await prisma.flowDefinition.findUnique({ where: { id: flowId } });
  if (!flow || !flow.isActive) return null;

  if (flow.publishedVersionId) {
    const version = await prisma.flowVersion.findUnique({ where: { id: flow.publishedVersionId } });
    if (version) {
      return {
        nodes: Array.isArray(version.nodes) ? (version.nodes as unknown as SerializedFlowNode[]) : [],
        edges: Array.isArray(version.edges) ? (version.edges as unknown as SerializedFlowEdge[]) : [],
      };
    }
  }

  return {
    nodes: Array.isArray(flow.nodes) ? (flow.nodes as unknown as SerializedFlowNode[]) : [],
    edges: Array.isArray(flow.edges) ? (flow.edges as unknown as SerializedFlowEdge[]) : [],
  };
}
