/**
 * bootstrap/workers.ts
 *
 * Single entry point that starts every BullMQ worker EXACTLY ONCE. Each worker
 * module registers a `new Worker(...)` as an import side effect, so importing it
 * here starts it. Centralising the imports here (instead of scattering them
 * across server.ts and a second worker entrypoint) is what guarantees no worker
 * is started twice.
 *
 * All workers run in the single web process. Several of them emit Socket.IO
 * events via emitToHotel, and `io` only has connected clients in the web process
 * (there is no Socket.IO Redis adapter) — so they MUST run here, not in a
 * separate process. See whatsappInbound.worker.ts header for the full rationale.
 *
 * Queue → worker map:
 *   whatsapp-inbound       → whatsappInbound.worker   (guest inbound bot pipeline)
 *   instagram-inbound      → instagram.worker         (guest inbound IG pipeline)
 *   flow-resume            → flowResumeWorker         (delayed flow continuation)
 *   confirmation-sequence  → confirmationSequence.worker (staff-confirmed sends)
 *   whatsapp-out           → outboundSend.worker      (durable delayed staff replies)
 */
import { logger } from "../utils/logger";

import "../workers/whatsappInbound.worker";
import "../workers/instagram.worker";
import "../workers/flowResumeWorker";
import "../workers/confirmationSequence.worker";
import "../workers/outboundSend.worker";

const log = logger.child({ service: "workers" });

const WORKER_QUEUES = [
  "whatsapp-inbound",
  "instagram-inbound",
  "flow-resume",
  "confirmation-sequence",
  "whatsapp-out",
] as const;

/** No-op initializer — importing this module has already started the workers.
 *  Exists so server.ts can call it explicitly and log a clear startup line. */
export function startWorkers(): void {
  log.info({ workers: WORKER_QUEUES }, "BullMQ workers started");
}
