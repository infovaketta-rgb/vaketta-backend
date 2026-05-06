import { MessageChannel } from "@prisma/client";
import { logIncomingMessage } from "./message.service";
export { encryptInstagramToken, decryptInstagramToken } from "../utils/encryption.utils";

export async function processInstagramInboundEvent(event: any): Promise<void> {
  console.log("[Instagram] recipient:", event.recipient?.id, "sender:", event.sender?.id, "mid:", event.message?.mid);
  const senderId    = event.sender?.id    as string | undefined;
  const recipientId = event.recipient?.id as string | undefined;
  const mid         = event.message?.mid  as string | undefined;
  const text        = event.message?.text as string | null ?? null;

  if (!senderId || !recipientId || !mid) return;

  // Delegate to the shared inbound pipeline — this gives Instagram the same
  // guest upsert, socket emit, bot auto-reply, push notification, and usage
  // tracking that WhatsApp receives via the same function.
  await logIncomingMessage({
    fromPhone:   senderId,
    toPhone:     recipientId,
    body:        text,
    messageType: "text",
    wamid:       mid,
    channel:     MessageChannel.INSTAGRAM,
  });
}