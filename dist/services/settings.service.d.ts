export declare function getHotelSettings(hotelId: string): Promise<{
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
    menu: ({
        items: {
            id: string;
            type: string;
            isActive: boolean;
            order: number;
            menuId: string;
            key: string;
            label: string;
            replyText: string;
            flowId: string | null;
        }[];
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        hotelId: string;
        isActive: boolean;
        title: string;
    }) | null;
}>;
export declare function updateHotelConfig(hotelId: string, data: {
    autoReplyEnabled?: boolean;
    bookingEnabled?: boolean;
    bookingFlowId?: string | null;
    businessStartHour?: number;
    businessEndHour?: number;
    timezone?: string;
    defaultLanguage?: string;
    welcomeMessage?: string;
    nightMessage?: string;
}): Promise<{
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
}>;
export declare function updateBotMessages(hotelId: string, botMessages: Record<string, string>): Promise<{
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
}>;
export declare function getMenu(hotelId: string): Promise<({
    items: {
        id: string;
        type: string;
        isActive: boolean;
        order: number;
        menuId: string;
        key: string;
        label: string;
        replyText: string;
        flowId: string | null;
    }[];
} & {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string;
    isActive: boolean;
    title: string;
}) | {
    items: never[];
}>;
export declare function addMenuItem(hotelId: string, item: {
    key: string;
    label: string;
    replyText: string;
    type?: string;
    order: number;
    flowId?: string | null;
}): Promise<{
    id: string;
    type: string;
    isActive: boolean;
    order: number;
    menuId: string;
    key: string;
    label: string;
    replyText: string;
    flowId: string | null;
}>;
export declare function updateMenuItem(itemId: string, hotelId: string, data: Partial<{
    key: string;
    label: string;
    replyText: string;
    type: string;
    order: number;
    isActive: boolean;
    flowId: string | null;
}>): Promise<{
    id: string;
    type: string;
    isActive: boolean;
    order: number;
    menuId: string;
    key: string;
    label: string;
    replyText: string;
    flowId: string | null;
}>;
export declare function deleteMenuItem(itemId: string, hotelId: string): Promise<{
    id: string;
    type: string;
    isActive: boolean;
    order: number;
    menuId: string;
    key: string;
    label: string;
    replyText: string;
    flowId: string | null;
}>;
export declare function updateMenuTitle(hotelId: string, title: string): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    hotelId: string;
    isActive: boolean;
    title: string;
}>;
export declare function getWhatsAppConfig(hotelId: string): Promise<{
    metaPhoneNumberId: string | null;
    metaAccessToken: string | null;
    metaWabaId: string | null;
    metaVerifyToken: string | null;
    connected: boolean;
}>;
export declare function testWhatsAppConnection(hotelId: string): Promise<{
    ok: boolean;
    detail?: string;
}>;
export declare function updateWhatsAppConfig(hotelId: string, data: {
    metaPhoneNumberId?: string;
    metaAccessToken?: string;
    metaWabaId?: string;
    metaVerifyToken?: string;
}): Promise<{
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
}>;
export declare function updateHotelProfile(hotelId: string, data: {
    name?: string;
    location?: string;
    email?: string;
    description?: string;
    checkInTime?: string;
    checkOutTime?: string;
    website?: string;
}): Promise<{
    id: string;
    name: string;
    phone: string;
    location: string | null;
    email: string | null;
    description: string | null;
    checkInTime: string;
    checkOutTime: string;
    website: string | null;
}>;
//# sourceMappingURL=settings.service.d.ts.map