import prisma from "../db/connect";
// Import from encryption.utils directly — the ./instagram.service re-export
// would drag in message.service → realtime/emit → server.ts (heavy chain).
import { decryptInstagramToken } from "../utils/encryption.utils";
import { logger } from "../utils/logger";
import { getMetaVersion, withRetry } from "../utils/metaApi.utils";
import { splitInstagramMessage } from "./instagramMessageSplitter";

const log = logger.child({ service: "instagram-send" });

// Exported for reuse by instagram.profile.service.ts — one decrypt path.
export async function resolveInstagramCredentials(hotelId:string){
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
    igAccountId: config.instagramBusinessAccountId ?? null,
    mockMode:
      process.env.MOCK_INSTAGRAM_SEND==="true"
  };
}

// ── Send host: graph.instagram.com, NOT graph.facebook.com ──────────────────
// The connect flow is "Instagram API with Instagram Login" (Business Login for
// Instagram): it stores a long-lived IG USER token (IGAA… prefix). Those tokens
// are only parseable by graph.instagram.com — posting them to the legacy
// Messenger-Platform endpoint graph.facebook.com/{ig-id}/messages fails with
// OAuthException 190 "Cannot parse access token" (that host expects EAA… Page
// tokens from Embedded Signup). Auth flow and send API must belong to the SAME
// Meta API generation. `/me/messages` is used instead of `/{ig-id}/messages` so
// the token itself identifies the account — sidestepping the user_id vs
// app-scoped-id namespace ambiguity of the stored instagramBusinessAccountId.
// Docs: developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/
async function metaPost(
 body:any,
 accessToken:string
){
 const version = await getMetaVersion();
 const res=await fetch(
 `https://graph.instagram.com/${version}/me/messages`,
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



// ── Shared dispatch (gate → creds → mock → guard → retry) ────────────────────
// Every IG send goes through the same lifecycle: the outbound feature flag, the
// hotel's stored IG-Login token, the mock short-circuit, and the connect-
// completeness guard. `message` is the IG-Login `message` object; the recipient
// wrapper and retry policy are identical for all message shapes.
async function dispatchInstagramMessage(
 hotelId:string,
 toPhone:string, // ig scoped id
 message:object,
 mockLabel:string,
 mockMeta:Record<string,unknown> = {},
){
    if(process.env.INSTAGRAM_OUTBOUND_ENABLED !== "true"){
        throw new Error("Instagram outbound disabled");
    }

 const {
   accessToken,
   igAccountId,
   mockMode
 }=
 await resolveInstagramCredentials(
   hotelId
 );

 if(mockMode){
   log.info({ toPhone, ...mockMeta }, mockLabel);
   return null;
 }

 // igAccountId is no longer part of the URL (`/me/messages` — see metaPost),
 // but a missing id still means the connect flow never completed: fail fast
 // with the same error as before rather than letting Meta reject the send.
 if(!igAccountId){
   throw new Error("Instagram business account ID not configured");
 }

 // Body shape per the IG-Login messaging API: recipient + message only.
 // (`messaging_type` was a Messenger-Platform field — not part of this API.)
 return withRetry(()=>metaPost({
   recipient:{
     id:toPhone
   },
   message
 },accessToken));
}

export async function sendInstagramTextMessage(
 input:{
   toPhone:string; // ig scoped id
   text:string;
   hotelId:string;
 }
){
 const { toPhone, text, hotelId } = input;
 const chunks = splitInstagramMessage(text);

 let result;
 for(const chunk of chunks){
   result = await dispatchInstagramMessage(
     hotelId, toPhone,
     { text: chunk },
     "MOCK INSTAGRAM send",
     { preview: chunk?.slice(0, 80) },
   );
 }
 return result;
}

// ── Interactive sends (IG-Login messaging API) ────────────────────────────────
// Caps per Meta docs: quick replies ≤13 (title ≤20); button template ≤3 buttons
// (title ≤20, text ≤640); generic template ≤10 elements (title/subtitle ≤80,
// ≤3 buttons each). Callers (the Instagram renderer) enforce the count caps and
// decide fallback; these senders only apply the hard character slices, mirroring
// how the WhatsApp senders own their own title slices.

export async function sendInstagramQuickReplies(
 input:{
   toPhone:string;
   hotelId:string;
   text:string;
   quickReplies:Array<{ title:string; payload:string }>;
 }
){
 const { toPhone, hotelId, text, quickReplies } = input;
 return dispatchInstagramMessage(
   hotelId, toPhone,
   {
     text,
     quick_replies: quickReplies.map((q)=>({
       content_type: "text",
       title:        q.title.slice(0, 20),
       payload:      q.payload,
     })),
   },
   "MOCK INSTAGRAM quick-replies send",
   { count: quickReplies.length },
 );
}

export async function sendInstagramButtonTemplate(
 input:{
   toPhone:string;
   hotelId:string;
   text:string;
   buttons:Array<{ title:string; payload:string }>;
 }
){
 const { toPhone, hotelId, text, buttons } = input;
 return dispatchInstagramMessage(
   hotelId, toPhone,
   {
     attachment:{
       type:"template",
       payload:{
         template_type:"button",
         text,
         buttons: buttons.map((b)=>({
           type:    "postback",
           title:   b.title.slice(0, 20),
           payload: b.payload,
         })),
       },
     },
   },
   "MOCK INSTAGRAM button-template send",
   { count: buttons.length },
 );
}

export type InstagramGenericElement = {
  title:     string;
  subtitle?: string;
  imageUrl?: string;
  buttons:   Array<{ title:string; payload:string }>;
};

export async function sendInstagramGenericTemplate(
 input:{
   toPhone:string;
   hotelId:string;
   elements:InstagramGenericElement[];
 }
){
 const { toPhone, hotelId, elements } = input;
 return dispatchInstagramMessage(
   hotelId, toPhone,
   {
     attachment:{
       type:"template",
       payload:{
         template_type:"generic",
         elements: elements.map((el)=>({
           title: el.title.slice(0, 80),
           ...(el.subtitle ? { subtitle: el.subtitle.slice(0, 80) } : {}),
           ...(el.imageUrl ? { image_url: el.imageUrl } : {}),
           buttons: el.buttons.slice(0, 3).map((b)=>({
             type:    "postback",
             title:   b.title.slice(0, 20),
             payload: b.payload,
           })),
         })),
       },
     },
   },
   "MOCK INSTAGRAM generic-template send",
   { count: elements.length },
 );
}

export async function sendInstagramMediaMessage(
 input:{
   toPhone:string;
   hotelId:string;
   mediaType:"image"|"video"|"audio";
   mediaUrl:string;
 }
){
 const { toPhone, hotelId, mediaType, mediaUrl } = input;
 return dispatchInstagramMessage(
   hotelId, toPhone,
   {
     attachment:{
       type:    mediaType,
       payload: { url: mediaUrl },
     },
   },
   "MOCK INSTAGRAM media send",
   { mediaType, mediaUrl },
 );
}