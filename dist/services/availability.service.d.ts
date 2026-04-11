export interface CalendarCell {
    availableRooms: number;
    totalRooms: number;
    bookedRooms: number;
    price: number;
    isOverridden: boolean;
}
export interface CalendarResult {
    roomTypes: {
        id: string;
        name: string;
        basePrice: number;
        totalRooms: number;
    }[];
    dates: string[];
    cells: Record<string, Record<string, CalendarCell>>;
}
export declare function getCalendarData(hotelId: string, startDate: string, endDate: string): Promise<CalendarResult>;
export declare function upsertInventoryCell(hotelId: string, roomTypeId: string, date: string, availableRooms: number, price?: number | null): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string;
    price: number | null;
    date: Date;
    roomTypeId: string;
    availableRooms: number;
}>;
export declare function bulkUpsertInventory(hotelId: string, roomTypeId: string, startDate: string, endDate: string, availableRooms: number, price?: number | null): Promise<{
    updated: number;
}>;
export declare function checkRoomAvailability(hotelId: string, roomTypeId: string, checkIn: string | Date, checkOut: string | Date): Promise<{
    available: boolean;
    availableCount: number;
}>;
export declare function getAvailabilityEnabled(hotelId: string): Promise<boolean>;
export declare function setAvailabilityEnabled(hotelId: string, enabled: boolean): Promise<void>;
//# sourceMappingURL=availability.service.d.ts.map