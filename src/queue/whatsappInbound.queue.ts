import { Queue } from "bullmq";
import { redis } from "./redis";

// Durable queue for inbound WhatsApp messages. The webhook controller ACKs Meta
// and enqueues here instead of running the bot pipeline as an unbounded in-process
// promise. attempts/backoff/jobId(=wamid) make Meta re-deliveries and transient
// infra blips safe — logIncomingMessage also dedups by wamid at the DB level.
export const whatsappInboundQueue = new Queue("whatsapp-inbound", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type:  "exponential",
      delay: 10_000, // 10s → 20s → 40s
    },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});
