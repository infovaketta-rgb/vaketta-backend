export declare function assignPlanToHotel(hotelId: string, planId: string): Promise<{
    id: string;
    createdAt: Date;
    planId: string | null;
    hotelId: string;
    currency: string;
    conversationLimit: number;
    aiReplyLimit: number;
    extraConversationCharge: number;
    extraAiReplyCharge: number;
    planName: string;
    price: number;
    startDate: Date;
    endDate: Date | null;
}>;
export declare function startTrial(hotelId: string, overrides?: {
    durationDays?: number;
    conversationLimit?: number;
    aiReplyLimit?: number;
}): Promise<{
    subscriptionStatus: string;
    billingStartDate: Date;
    billingEndDate: Date;
    conversationLimit: number;
    aiReplyLimit: number;
    durationDays: number;
}>;
export declare function getHotelBilling(hotelId: string): Promise<{
    hotel: {
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
    };
    subscription: {
        id: string;
        createdAt: Date;
        planId: string | null;
        hotelId: string;
        currency: string;
        conversationLimit: number;
        aiReplyLimit: number;
        extraConversationCharge: number;
        extraAiReplyCharge: number;
        planName: string;
        price: number;
        startDate: Date;
        endDate: Date | null;
    } | null;
}>;
export declare function getAdminBillingAnalytics(): Promise<{
    mrr: number;
    activeHotelsCount: number;
    mrrHistory: {
        month: string;
        mrr: number;
    }[];
}>;
export declare function expireOverdueSubscriptions(): Promise<number>;
//# sourceMappingURL=billing.service.d.ts.map