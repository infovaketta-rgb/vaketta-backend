export declare function createPlan(data: {
    name: string;
    currency: string;
    priceMonthly: number;
    conversationLimit: number;
    aiReplyLimit: number;
    extraConversationCharge?: number;
    extraAiReplyCharge?: number;
}): Promise<{
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
}>;
export declare function getPlans(includeInactive?: boolean): Promise<({
    _count: {
        hotels: number;
    };
} & {
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
})[]>;
export declare function getPlanById(id: string): Promise<{
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
} | null>;
export declare function updatePlan(id: string, data: {
    name?: string;
    currency?: string;
    priceMonthly?: number;
    conversationLimit?: number;
    aiReplyLimit?: number;
    extraConversationCharge?: number;
    extraAiReplyCharge?: number;
    isActive?: boolean;
}): Promise<{
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
}>;
//# sourceMappingURL=plan.service.d.ts.map