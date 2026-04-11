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
