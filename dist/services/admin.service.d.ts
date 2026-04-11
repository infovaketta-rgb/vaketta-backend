import { UserRole, VakettaAdminRole } from "@prisma/client";
export declare function adminLoginService(email: string, password: string): Promise<{
    token: string;
    admin: {
        id: string;
        name: string;
        email: string;
        createdAt: Date;
        role: import(".prisma/client").$Enums.VakettaAdminRole;
    };
}>;
export declare function listHotelsService(page?: number, limit?: number, search?: string): Promise<{
    hotels: ({
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
        _count: {
            guests: number;
            bookings: number;
            users: number;
        };
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
    })[];
    total: number;
    page: number;
    limit: number;
    pages: number;
}>;
export declare function getHotelService(id: string): Promise<{
    roomTypes: {
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
    }[];
    users: {
        id: string;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
        isActive: boolean;
    }[];
    plan: {
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        isActive: boolean;
        currency: string;
        priceMonthly: number;
        conversationLimit: number;
        aiReplyLimit: number;
        extraConversationCharge: number;
        extraAiReplyCharge: number;
    } | null;
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
    _count: {
        guests: number;
        bookings: number;
        messages: number;
    };
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
export declare function updateHotelService(id: string, data: {
    name?: string;
    phone?: string;
}): Promise<{
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
export declare function deleteHotelService(id: string): Promise<{
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
export declare function listAdminsService(): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    role: import(".prisma/client").$Enums.VakettaAdminRole;
}[]>;
export declare function createAdminService(name: string, email: string, password: string, role?: VakettaAdminRole): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    role: import(".prisma/client").$Enums.VakettaAdminRole;
}>;
export declare function deleteAdminService(id: string, requesterId: string): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    password: string;
    role: import(".prisma/client").$Enums.VakettaAdminRole;
}>;
export declare function createHotelUserService(hotelId: string, data: {
    name: string;
    email: string;
    password: string;
    role: UserRole;
}): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    role: import(".prisma/client").$Enums.UserRole;
    isActive: boolean;
}>;
export declare function updateHotelUserService(userId: string, hotelId: string, data: {
    name?: string;
    email?: string;
    role?: UserRole;
    isActive?: boolean;
}): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    role: import(".prisma/client").$Enums.UserRole;
    isActive: boolean;
}>;
export declare function deleteHotelUserService(userId: string, hotelId: string): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    hotelId: string;
    password: string;
    role: import(".prisma/client").$Enums.UserRole;
    isActive: boolean;
}>;
export declare function updateAdminSettingsService(id: string, data: {
    name?: string;
    email?: string;
    currentPassword?: string;
    newPassword?: string;
}): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    role: import(".prisma/client").$Enums.VakettaAdminRole;
}>;
//# sourceMappingURL=admin.service.d.ts.map