import { MessageChannel } from "@prisma/client";
import { sendTextMessage } from "./whatsapp.send.service";
import { sendInstagramTextMessage } from "./instagram.send.service";

export async function sendChannelMessage(input:{
 channel: MessageChannel;
 toPhone:string;
 fromPhone:string;
 hotelId:string;
 guestId?:string|null;
 text:string;
}){

 if(
   input.channel===MessageChannel.INSTAGRAM
 ){
   return sendInstagramTextMessage({
   toPhone: input.toPhone,
   text: input.text,
   hotelId: input.hotelId
   });
 }

    return sendTextMessage({
 toPhone: input.toPhone,
 fromPhone: input.fromPhone,
 hotelId: input.hotelId,
 guestId: input.guestId ?? null,
 text: input.text
});
}