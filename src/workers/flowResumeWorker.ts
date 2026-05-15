import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import { executeFlowStep } from "../automation/flowRuntime";
import { sendTextMessage } from "../services/whatsapp.send.service";
import { updateSession } from "../services/session.service";

const log = logger.child({ service: "flow-resume-worker" });

const worker = new Worker(
  "flow-resume",
  async (job) => {
    const { pausedFlowId } = job.data as { pausedFlowId: string };

    // Load with guest + hotel for phone numbers needed by sendTextMessage
    const paused = await prisma.pausedFlow.findUnique({
      where:   { id: pausedFlowId },
      include: { guest: true, hotel: true },
    });

    if (!paused) {
      log.warn({ pausedFlowId }, "PausedFlow not found — already processed or deleted, skipping");
      return;
    }

    // Delete before processing — idempotent guard against double-fire
    await prisma.pausedFlow.delete({ where: { id: pausedFlowId } });

    const state       = `FLOW:${paused.flowId}:${paused.nodeId}`;
    const flowVars    = paused.flowVars as Record<string, string>;
    const sessionData = { flow: { flowId: paused.flowId, flowVars } };

    // Restore ConversationSession so the state machine is consistent with what
    // executeFlowStep will write. The passed sessionData drives execution; this
    // upsert just ensures the DB row matches in case of a concurrent lookup.
    await updateSession(paused.guestId, paused.hotelId, state, sessionData);

    try {
      const reply = await executeFlowStep(
        paused.hotelId,
        paused.guestId,
        state,
        sessionData,
        "", // empty input — BullMQ timer fired, not a guest message
      );

      if (reply) {
        await sendTextMessage({
          toPhone:   paused.guest.phone,
          fromPhone: paused.hotel.phone,
          hotelId:   paused.hotelId,
          guestId:   paused.guestId,
          text:      reply,
        });
      }
    } catch (err: any) {
      log.error({ err, pausedFlowId, guestId: paused.guestId }, "flow resume execution failed");
      // Best-effort apology so the guest isn't left hanging silently
      await sendTextMessage({
        toPhone:   paused.guest.phone,
        fromPhone: paused.hotel.phone,
        hotelId:   paused.hotelId,
        guestId:   paused.guestId,
        text:      "Sorry, we encountered an issue resuming your conversation. Please try again by sending a message.",
      }).catch(() => {});
    }
  },
  {
    connection:      redis,
    concurrency:     2,
    lockDuration:    120_000,  // 2-min lock → renewal every ~1 min
    stalledInterval: 600_000,  // check stalled jobs every 10 min
    maxStalledCount: 1,
  },
);

worker.on("failed", async (job, err) => {
  log.error({ err, jobId: job?.id, pausedFlowId: job?.data?.pausedFlowId }, "flow-resume job failed");
  await prisma.deadLetterEvent.create({
    data: {
      provider: "flow-resume",
      payload:  job?.data ?? {},
      error:    String(err),
    },
  }).catch((dbErr) => log.error({ dbErr }, "dead-letter write failed"));
});

worker.on("error", (err) => {
  log.error({ err }, "flow-resume worker error");
});
