export type AutoReplyMode = "OFF" | "DAY" | "NIGHT";
export declare function shouldAutoReply(config: {
    autoReplyEnabled: boolean;
    businessStartHour: number;
    businessEndHour: number;
    timezone: string;
}, lastHandledByStaff: boolean): AutoReplyMode;
//# sourceMappingURL=shouldAutoReply.d.ts.map