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
   connection:redis,
   concurrency:5
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