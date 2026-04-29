import { Request, Response } from "express";
import { instagramQueue } from "../queue/instagram.queue";
import prisma from "../db/connect";
import crypto from "crypto";



export function verifyInstagramWebhook(
 req:Request,
 res:Response
){
 const mode=
 req.query["hub.mode"];

 const token=
 req.query["hub.verify_token"];

 const challenge=
 req.query["hub.challenge"];

 const expectedToken = process.env.INSTAGRAM_VERIFY_TOKEN ?? "";
 const ha = crypto.createHash("sha256").update(typeof token === "string" ? token : "").digest();
 const hb = crypto.createHash("sha256").update(expectedToken).digest();
 const tokenMatch = crypto.timingSafeEqual(ha, hb);

 if (mode === "subscribe" && tokenMatch) {
   return res.status(200).send(challenge);
 }

 return res.sendStatus(403);
}

export async function handleInstagramWebhook(
 req:any,
 res:Response
){


 res.sendStatus(200);

 try{

 for(
  const entry of req.body.entry||[]
 ){

 for(
  const event of entry.messaging||[]
 ){
   const mid:string|undefined = event.message?.mid;
   if(!mid) continue;

   // Pre-create the idempotency record so the worker's claim guard
   // (WebhookEvent.updateMany) finds a row to claim on first run.
   // On Meta retries the create throws P2002 (unique violation) — that's
   // expected and safe; BullMQ jobId dedup also prevents re-processing.
   try {
     await prisma.webhookEvent.create({
       data: {
         provider:        "instagram",
         externalEventId: mid,
         payloadHash:     crypto.createHash("sha256").update(mid).digest("hex"),
         processed:       false,
       },
     });
   } catch (err: any) {
     if (err?.code !== "P2002") throw err;
   }

   await instagramQueue.add(
    "instagram-inbound",
    { event, mid },
    { jobId: mid }
   );
 }

 }

 }catch(err){
 console.error(
  "[Instagram webhook error]",
   err
 );
 }
}