export type StatusUpdatePayload = {
    hotelId: string;
    messageId: string;
    status: string;
};
/** Called from the worker process after a DB status update */
export declare function publishMessageStatus(payload: StatusUpdatePayload): void;
/** Called once from the main server process at startup */
export declare function subscribeMessageStatus(onUpdate: (payload: StatusUpdatePayload) => void): void;
//# sourceMappingURL=statusBus.d.ts.map