"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHotelFlows = getHotelFlows;
exports.getHotelFlow = getHotelFlow;
exports.createHotelFlow = createHotelFlow;
exports.updateHotelFlow = updateHotelFlow;
exports.deleteHotelFlow = deleteHotelFlow;
exports.getAllFlows = getAllFlows;
exports.getAdminFlow = getAdminFlow;
exports.createAdminFlow = createAdminFlow;
exports.updateAdminFlow = updateAdminFlow;
exports.deleteAdminFlow = deleteAdminFlow;
const connect_1 = __importDefault(require("../db/connect"));
// ── Hotel-facing (hotel-private flows + read access to global templates) ───────
/** Returns hotel-private flows + global templates (for the flow picker) */
async function getHotelFlows(hotelId) {
    return connect_1.default.flowDefinition.findMany({
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
async function getHotelFlow(id, hotelId) {
    const flow = await connect_1.default.flowDefinition.findUnique({ where: { id } });
    if (!flow)
        return null;
    if (flow.hotelId !== hotelId && !flow.isTemplate)
        return null;
    return flow;
}
/** Create a hotel-private flow */
async function createHotelFlow(hotelId, dto) {
    return connect_1.default.flowDefinition.create({
        data: {
            hotelId,
            name: dto.name,
            description: dto.description ?? null,
            nodes: (dto.nodes ?? []),
            edges: (dto.edges ?? []),
            isTemplate: false,
        },
    });
}
/** Update a hotel-private flow (hotel must own it — cannot edit templates) */
async function updateHotelFlow(id, hotelId, dto) {
    const flow = await connect_1.default.flowDefinition.findUnique({ where: { id } });
    if (!flow || flow.hotelId !== hotelId)
        throw new Error("Flow not found or access denied");
    return connect_1.default.flowDefinition.update({
        where: { id },
        data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.nodes !== undefined && { nodes: dto.nodes }),
            ...(dto.edges !== undefined && { edges: dto.edges }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
    });
}
/** Delete a hotel-private flow */
async function deleteHotelFlow(id, hotelId) {
    const flow = await connect_1.default.flowDefinition.findUnique({ where: { id } });
    if (!flow || flow.hotelId !== hotelId)
        throw new Error("Flow not found or access denied");
    return connect_1.default.flowDefinition.delete({ where: { id } });
}
// ── Admin-facing (full access across all flows) ────────────────────────────────
async function getAllFlows(filter) {
    return connect_1.default.flowDefinition.findMany({
        where: {
            ...(filter?.isTemplate !== undefined && { isTemplate: filter.isTemplate }),
            ...(filter?.hotelId !== undefined && { hotelId: filter.hotelId }),
        },
        orderBy: [{ isTemplate: "desc" }, { createdAt: "desc" }],
        include: { hotel: { select: { id: true, name: true } } },
    });
}
async function getAdminFlow(id) {
    return connect_1.default.flowDefinition.findUnique({
        where: { id },
        include: { hotel: { select: { id: true, name: true } } },
    });
}
/** Admin creates a flow — can be global template (hotelId=null, isTemplate=true) or per-hotel */
async function createAdminFlow(dto) {
    return connect_1.default.flowDefinition.create({
        data: {
            hotelId: dto.hotelId ?? null,
            name: dto.name,
            description: dto.description ?? null,
            nodes: (dto.nodes ?? []),
            edges: (dto.edges ?? []),
            isTemplate: dto.isTemplate ?? false,
        },
        include: { hotel: { select: { id: true, name: true } } },
    });
}
async function updateAdminFlow(id, dto) {
    return connect_1.default.flowDefinition.update({
        where: { id },
        data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.nodes !== undefined && { nodes: dto.nodes }),
            ...(dto.edges !== undefined && { edges: dto.edges }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
            ...(dto.isTemplate !== undefined && { isTemplate: dto.isTemplate }),
            ...(dto.hotelId !== undefined && { hotelId: dto.hotelId }),
        },
        include: { hotel: { select: { id: true, name: true } } },
    });
}
async function deleteAdminFlow(id) {
    return connect_1.default.flowDefinition.delete({ where: { id } });
}
//# sourceMappingURL=flow.service.js.map