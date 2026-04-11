export type SessionData = {
    bookingGuestName?: string;
    bookingRoomTypeId?: string;
    bookingRoomTypeName?: string;
    bookingPricePerNight?: number;
    bookingCheckIn?: string;
    bookingCheckOut?: string;
    roomList?: Array<{
        id: string;
        name: string;
        basePrice: number;
        capacity: number | null;
        description: string;
    }>;
    flow?: {
        flowId: string;
        flowVars: Record<string, string>;
        waitingFor?: "answer";
        lastInput?: string;
    };
};
export declare function getOrCreateSession(guestId: string, hotelId: string): Promise<{
    data: import("@prisma/client/runtime/library").JsonValue;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string;
    guestId: string;
    state: string;
}>;
export declare function updateSession(guestId: string, hotelId: string, state: string, data?: SessionData): Promise<{
    data: import("@prisma/client/runtime/library").JsonValue;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string;
    guestId: string;
    state: string;
}>;
export declare function resetSession(guestId: string, hotelId: string): Promise<{
    data: import("@prisma/client/runtime/library").JsonValue;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string;
    guestId: string;
    state: string;
}>;
//# sourceMappingURL=session.service.d.ts.map