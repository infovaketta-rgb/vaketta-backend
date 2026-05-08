import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { processInstagramInboundEvent } from "../services/instagram.service";
import { logger } from "../utils/logger";

const log = logger.child({
 service:"instagram-worker"
});

log.info("Instagram worker booting...");

const worker = new Worker(
 "instagram-inbound",

 async(job)=>{

   const { event, mid } = job.data;

   // Atomic claim using webhook table
   const claimed =
    await prisma.webhookEvent.updateMany({
      where:{
        externalEventId:mid,
        processed:false
      },
      data:{
        attempts:{
          increment:1
        }
      }
    });

   if(claimed.count===0){
      log.warn(
       {mid},
       "already claimed, skipping"
      );
      return;
   }

   try{

      await processInstagramInboundEvent(
         event
      );

      await prisma.webhookEvent.update({
        where:{
              provider_externalEventId:{
              provider:"instagram",
              externalEventId:mid
             }
        },
        data:{
          processed:true,
          processedAt:new Date()
        }
      });

      log.info(
       {mid},
       "instagram event processed"
      );

   }catch(err){

      log.error(
       {err,mid},
       "instagram job failed"
      );

      throw err;
   }

 },
 {
   connection:     redis,
   concurrency:    2,
   // Upstash free tier (500 k commands/day) — reduce idle Redis pressure:
   drainDelay:     5_000,   // wait 5 s before re-polling an empty queue (default: 5 ms)
   lockDuration:   120_000, // 2-min lock → renewal every ~1 min instead of every 15 s
   stalledInterval:300_000, // check for stalled jobs every 5 min (default: 30 s)
   maxStalledCount:1,       // stalled job counts as one failure, then falls to retry policy
 }
);

worker.on(
 "failed",
 async(job,err)=>{

  log.error(
   {
    err,
    jobId:job?.id
   },
   "job exhausted retries"
  );

  await prisma.deadLetterEvent.create({
    data:{
      provider:"instagram",
      payload:job?.data ?? {},
      error:String(err)
    }
  });

});

worker.on(
 "error",
 (err)=>{
   log.error(
    {err},
    "instagram worker error"
   );
 });