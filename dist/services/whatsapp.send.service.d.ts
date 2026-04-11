export declare function sendTextMessage(input: {
    toPhone: string;
    fromPhone: string;
    hotelId: string;
    guestId?: string | null;
    text: string;
}): Promise<any>;
export declare function sendMediaMessage(input: {
    toPhone: string;
    hotelId: string;
    messageType: string;
    mediaUrl: string;
    mimeType: string;
    fileName?: string | null;
    caption?: string | null;
}): Promise<any>;
//# sourceMappingURL=whatsapp.send.service.d.ts.map