import { SerializedFlowNode, SerializedFlowEdge } from "../automation/flowTypes";
interface FlowCreateDto {
    name: string;
    description?: string;
    nodes?: SerializedFlowNode[];
    edges?: SerializedFlowEdge[];
    isTemplate?: boolean;
}
interface FlowUpdateDto {
    name?: string;
    description?: string;
    nodes?: SerializedFlowNode[];
    edges?: SerializedFlowEdge[];
    isActive?: boolean;
    isTemplate?: boolean;
}
/** Returns hotel-private flows + global templates (for the flow picker) */
export declare function getHotelFlows(hotelId: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    isTemplate: boolean;
}[]>;
/** Get a single flow — must belong to hotel OR be a global template */
export declare function getHotelFlow(id: string, hotelId: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
} | null>;
/** Create a hotel-private flow */
export declare function createHotelFlow(hotelId: string, dto: FlowCreateDto): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
}>;
/** Update a hotel-private flow (hotel must own it — cannot edit templates) */
export declare function updateHotelFlow(id: string, hotelId: string, dto: FlowUpdateDto): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
}>;
/** Delete a hotel-private flow */
export declare function deleteHotelFlow(id: string, hotelId: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
}>;
export declare function getAllFlows(filter?: {
    isTemplate?: boolean;
    hotelId?: string | null;
}): Promise<({
    hotel: {
        id: string;
        name: string;
    } | null;
} & {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
})[]>;
export declare function getAdminFlow(id: string): Promise<({
    hotel: {
        id: string;
        name: string;
    } | null;
} & {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
}) | null>;
/** Admin creates a flow — can be global template (hotelId=null, isTemplate=true) or per-hotel */
export declare function createAdminFlow(dto: FlowCreateDto & {
    hotelId?: string | null;
}): Promise<{
    hotel: {
        id: string;
        name: string;
    } | null;
} & {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
}>;
export declare function updateAdminFlow(id: string, dto: FlowUpdateDto & {
    hotelId?: string | null;
}): Promise<{
    hotel: {
        id: string;
        name: string;
    } | null;
} & {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
}>;
export declare function deleteAdminFlow(id: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string | null;
    isActive: boolean;
    nodes: import("@prisma/client/runtime/library").JsonValue;
    edges: import("@prisma/client/runtime/library").JsonValue;
    isTemplate: boolean;
}>;
export {};
//# sourceMappingURL=flow.service.d.ts.map