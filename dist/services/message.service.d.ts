type IncomingMessageInput = {
    fromPhone: string;
    toPhone: string;
    body?: string | null;
    messageType: string;
    mediaUrl?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
};
type IncomingMessageResult = {
    hotelId: string;
    guestId: string;
    autoReply: boolean;
    autoReplyMessage: string | null;
};
export declare function logIncomingMessage(input: IncomingMessageInput): Promise<IncomingMessageResult>;
export declare function sendManualReply(input: {
    hotelId: string;
    guestId: string;
    fromPhone: string;
    toPhone: string;
    text: string;
}): Promise<{
    id: string;
    hotelId: string;
    status: import(".prisma/client").$Enums.MessageStatus;
    guestId: string | null;
    fromPhone: string;
    toPhone: string;
    body: string | null;
    messageType: string;
    mediaUrl: string | null;
    mimeType: string | null;
    fileName: string | null;
    direction: string;
    wamid: string | null;
    timestamp: Date;
    handledAt: Date | null;
}>;
export {};
//# sourceMappingURL=message.service.d.ts.map