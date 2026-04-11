export declare function createRoomType({ hotelId, name, basePrice, capacity, maxAdults, maxChildren, totalRooms, }: {
    hotelId: string;
    name: string;
    basePrice: number;
    capacity?: number;
    maxAdults?: number;
    maxChildren?: number;
    totalRooms?: number;
}): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    hotelId: string;
    amenities: string[];
    basePrice: number;
    capacity: number | null;
    maxAdults: number | null;
    maxChildren: number | null;
    totalRooms: number;
}>;
export declare function getRoomTypes(hotelId: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    hotelId: string;
    amenities: string[];
    basePrice: number;
    capacity: number | null;
    maxAdults: number | null;
    maxChildren: number | null;
    totalRooms: number;
}[]>;
export declare function updateRoomType({ id, hotelId, name, basePrice, capacity, maxAdults, maxChildren, totalRooms, }: {
    id: string;
    hotelId: string;
    name?: string;
    basePrice: number;
    capacity?: number;
    maxAdults?: number;
    maxChildren?: number;
    totalRooms?: number;
}): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    hotelId: string;
    amenities: string[];
    basePrice: number;
    capacity: number | null;
    maxAdults: number | null;
    maxChildren: number | null;
    totalRooms: number;
}>;
export declare function deleteRoomType({ id, hotelId, }: {
    id: string;
    hotelId: string;
}): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    hotelId: string;
    amenities: string[];
    basePrice: number;
    capacity: number | null;
    maxAdults: number | null;
    maxChildren: number | null;
    totalRooms: number;
}>;
//# sourceMappingURL=roomType.service.d.ts.map