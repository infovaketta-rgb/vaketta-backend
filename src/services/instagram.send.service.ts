import prisma from "../db/connect";
import { decryptInstagramToken } from "./instagram.service";
import { logger } from "../utils/logger";

const log = logger.child({ service: "instagram-send" });

async function resolveInstagramCredentials(hotelId:string){
  const config = await prisma.hotelConfig.findUnique({
    where:{ hotelId }
  });

  if(!config?.instagramAccessTokenEncrypted){
    throw new Error("Instagram credentials missing");
  }

  return {
    accessToken: decryptInstagramToken(
      config.instagramAccessTokenEncrypted
    ),
    mockMode:
      process.env.MOCK_INSTAGRAM_SEND==="true"
  };
}

async function withRetry<T>(
 fn:()=>Promise<T>,
 retries=3,
 baseMs=500
):Promise<T>{

 let lastErr;

 for(let i=0;i<=retries;i++){
   try{
     return await fn();
   }catch(err:any){
      lastErr=err;

      const retryable=
       !err.status ||
       err.status===429 ||
       err.status>=500;

      if(!retryable || i===retries){
        throw err;
      }

      const delay=
       baseMs*(2**i)+Math.random()*250;

      await new Promise(
        r=>setTimeout(r,delay)
      );
   }
 }

 throw lastErr;
}

async function metaPost(
 body:any,
 accessToken:string
){
 const res=await fetch(
 "https://graph.facebook.com/v25.0/me/messages",
 {
   method:"POST",
   headers:{
    Authorization:`Bearer ${accessToken}`,
    "Content-Type":"application/json"
   },
   body:JSON.stringify(body),
   signal:AbortSignal.timeout(15000)
 });

 const data=await res.json();

 if(!res.ok){
   const err:any=new Error(
     JSON.stringify(data)
   );
   err.status=res.status;
   throw err;
 }

 return data;
}



export async function sendInstagramTextMessage(
 input:{
   toPhone:string; // ig scoped id
   text:string;
   hotelId:string;
 }
){

    if(process.env.INSTAGRAM_OUTBOUND_ENABLED !== "true"){
        throw new Error("Instagram outbound disabled");
    }

 const {
   toPhone,
   text,
   hotelId
 }=input;

 const {
   accessToken,
   mockMode
 }=
 await resolveInstagramCredentials(
   hotelId
 );

 if(mockMode){
   log.info({ toPhone, preview: text?.slice(0, 80) }, "MOCK INSTAGRAM send");
   return null;
 }

 return withRetry(()=>metaPost({
   recipient:{
     id:toPhone
   },
   messaging_type:"RESPONSE",
   message:{
      text
   }
 },accessToken));

}