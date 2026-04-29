import crypto from "crypto";
import { MessageChannel } from "@prisma/client";
import { logIncomingMessage } from "./message.service";

function getEncryptionKey() {
  const keyHex = process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY;
  if (!keyHex) throw new Error("Missing encryption key");
  return Buffer.from(keyHex,"hex");
}

export function encryptInstagramToken(token: string): string {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  let encrypted =
    cipher.update(token,"utf8","hex") +
    cipher.final("hex");

  const tag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${encrypted}:${tag}`;
}

export function decryptInstagramToken(payload: string): string {
  const [ivHex, encrypted, tagHex] = payload.split(":");
  if(!ivHex||!encrypted||!tagHex){
    throw new Error("Invalid encrypted token")
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivHex,"hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex,"hex"));

  return (
    decipher.update(encrypted,"hex","utf8") +
    decipher.final("utf8")
  );
}

export async function processInstagramInboundEvent(event: any): Promise<void> {
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