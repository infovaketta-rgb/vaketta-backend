export declare function createHotel(name: string, phone: string): Promise<{
    config: {
        id: string;
        createdAt: Date;
        autoReplyEnabled: boolean;
        bookingEnabled: boolean;
        availabilityEnabled: boolean;
        bookingFlowId: string | null;
        businessStartHour: number;
        businessEndHour: number;
        defaultLanguage: string;
        timezone: string;
        welcomeMessage: string;
        nightMessage: string;
        botMessages: import("@prisma/client/runtime/library").JsonValue;
        metaPhoneNumberId: string | null;
        metaAccessToken: string | null;
        metaWabaId: string | null;
        metaVerifyToken: string | null;
        updatedAt: Date;
        hotelId: string;
    } | null;
} & {
    id: string;
    name: string;
    phone: string;
    apiKey: string | null;
    location: string | null;
    email: string | null;
    description: string | null;
    checkInTime: string;
    checkOutTime: string;
    website: string | null;
    subscriptionStatus: string;
    billingStartDate: Date | null;
    billingEndDate: Date | null;
    createdAt: Date;
    planId: string | null;
}>;
//# sourceMappingURL=hotel.service.d.ts.map