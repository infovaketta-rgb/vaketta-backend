export declare function currentMonth(): string;
export declare function incrementConversationUsage(hotelId: string): Promise<void>;
export declare function incrementAIUsage(hotelId: string): Promise<void>;
export declare function getCurrentUsage(hotelId: string): Promise<{
    id: string;
    updatedAt: Date;
    hotelId: string;
    month: string;
    conversationsUsed: number;
    aiRepliesUsed: number;
} | {
    hotelId: string;
    month: string;
    conversationsUsed: number;
    aiRepliesUsed: number;
}>;
export declare function getUsageHistory(hotelId: string, months?: number): Promise<{
    id: string;
    updatedAt: Date;
    hotelId: string;
    month: string;
    conversationsUsed: number;
    aiRepliesUsed: number;
}[]>;
export declare function getPlatformUsageThisMonth(): Promise<{
    conversations: number;
    aiReplies: number;
}>;
export declare function getPlatformUsageHistory(months?: number): Promise<{
    month: string;
    conversations: number;
    aiReplies: number;
}[]>;
//# sourceMappingURL=usage.service.d.ts.map