export declare function getTrialConfig(): Promise<{
    id: string;
    updatedAt: Date;
    conversationLimit: number;
    aiReplyLimit: number;
    durationDays: number;
    autoStartOnCreate: boolean;
    trialMessage: string;
}>;
export declare function updateTrialConfig(data: {
    durationDays?: number;
    conversationLimit?: number;
    aiReplyLimit?: number;
    autoStartOnCreate?: boolean;
    trialMessage?: string;
}): Promise<{
    id: string;
    updatedAt: Date;
    conversationLimit: number;
    aiReplyLimit: number;
    durationDays: number;
    autoStartOnCreate: boolean;
    trialMessage: string;
}>;
//# sourceMappingURL=trialConfig.service.d.ts.map