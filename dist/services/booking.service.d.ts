export declare function updateBookingService({ id, hotelId, guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid, }: {
    id: string;
    hotelId: string;
    guestName?: string;
    roomTypeId?: string;
    checkIn?: string;
    checkOut?: string;
    pricePerNight?: number;
    advancePaid?: number;
}): Promise<{
    guest: {
        id: string;
        name: string | null;
        phone: string;
        createdAt: Date;
        hotelId: string;
        lastHandledByStaff: boolean;
    };
    roomType: {
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
    };
} & {
    id: string;
    createdAt: Date;
    hotelId: string;
    status: import(".prisma/client").$Enums.BookingStatus;
    guestId: string;
    roomTypeId: string;
    guestName: string;
    checkIn: Date;
    checkOut: Date;
    pricePerNight: number;
    advancePaid: number;
    totalPrice: number;
}>;
export declare function createBookingService({ hotelId, guestId, guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid }: {
    hotelId: string;
    guestId: string;
    guestName: string;
    roomTypeId: string;
    checkIn: string;
    checkOut: string;
    pricePerNight?: number;
    advancePaid?: number;
}): Promise<{
    guest: {
        id: string;
        name: string | null;
        phone: string;
        createdAt: Date;
        hotelId: string;
        lastHandledByStaff: boolean;
    };
    roomType: {
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
    };
} & {
    id: string;
    createdAt: Date;
    hotelId: string;
    status: import(".prisma/client").$Enums.BookingStatus;
    guestId: string;
    roomTypeId: string;
    guestName: string;
    checkIn: Date;
    checkOut: Date;
    pricePerNight: number;
    advancePaid: number;
    totalPrice: number;
}>;
//# sourceMappingURL=booking.service.d.ts.map