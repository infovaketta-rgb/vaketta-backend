import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { sendTextMessage, sendMediaMessage } from "../services/whatsapp.send.service";
import { MessageStatus } from "@prisma/client";
import { publishMessageStatus } from "../realtime/statusBus";
import "./billing.worker"; // Start billing expiry cron alongside this worker

console.log("🚀 WhatsApp worker booting...");

new Worker(
  "whatsapp-out",
  async (job) => {
    const { messageId } = job.data;

    // Atomic guard: claim the message by updating status only if still PENDING.
    // If two workers pick up the same job (BullMQ retry / duplicate), only one
    // will succeed here — the other gets count=0 and exits safely.
    const claimed = await prisma.message.updateMany({
      where: { id: messageId, status: MessageStatus.PENDING },
      data:  { status: MessageStatus.SENT }, // placeholder — overwritten below on success/failure
    });

    if (claimed.count === 0) {
      // Another worker already processed this message — skip
      console.log(`⚠️  Message ${messageId} already claimed — skipping`);
      return;
    }

    // Re-fetch full message after claim
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return;

    try {
      const isMedia = ["image", "video", "audio", "document"].includes(message.messageType);

      const result = isMedia
        ? await sendMediaMessage({
            toPhone:     message.toPhone,
            hotelId:     message.hotelId,
            messageType: message.messageType,
            mediaUrl:    message.mediaUrl!,
            mimeType:    message.mimeType!,
            fileName:    message.fileName ?? null,
            caption:     message.body    ?? null,
          })
        : await sendTextMessage({
            toPhone:   message.toPhone,
            fromPhone: message.fromPhone,
            text:      message.body!,
            hotelId:   message.hotelId,
            guestId:   message.guestId ?? null,
          });

      // Persist wamid if Meta returned one (null in mock mode)
      const wamid = (result as any)?.messages?.[0]?.id ?? undefined;

      await prisma.message.update({
        where: { id: message.id },
        data:  { status: MessageStatus.SENT, ...(wamid ? { wamid } : {}) },
      });

      publishMessageStatus({ hotelId: message.hotelId, messageId: message.id, status: MessageStatus.SENT });
      console.log("✅ Message sent:", message.id);

    } catch (err) {
      await prisma.message.update({
        where: { id: message.id },
        data:  { status: MessageStatus.FAILED },
      });
      publishMessageStatus({ hotelId: message.hotelId, messageId: message.id, status: MessageStatus.FAILED });
      console.error("❌ Message failed:", message.id, err);
      throw err; // re-throw so BullMQ applies retry policy
    }
  },
  {
    connection:  redis,
    concurrency: 5,
  }
);
