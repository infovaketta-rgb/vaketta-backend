/**
 * channel.service.ts
 *
 * Unified outbound message dispatch — abstracts over WhatsApp, Instagram DM,
 * and future channels (Voice, SMS, email) behind a single send interface.
 *
 * Today only WhatsApp is live. As new channels are enabled, add a case to
 * dispatchOutboundMessage() and implement the corresponding send service.
 *
 * Callers (botEngine, flowRuntime, manualReply) always call sendToGuest()
 * and never import channel-specific services directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Channel identifiers (stored in Message.channel when the field is added):
 *   "whatsapp"  — Meta WhatsApp Business API       ✅ live
 *   "instagram" — Meta Instagram DM API            🔜 scaffold present
 *   "call"      — Twilio / Exotel voice            🔜 scaffold present
 *   "sms"       — SMS via Twilio / AWS SNS         🔜 future
 * ─────────────────────────────────────────────────────────────────────────────
 */
/*
import { sendTextMessage as waSendText } from "./whatsapp.send.service";

export type OutboundPayload = {
  hotelId:   string;
  toPhone:   string;   // recipient (guest)
  fromPhone: string;   // sender   (hotel number / channel ID)
  text:      string;
  channel?:  string;   // defaults to "whatsapp"
  guestId?:  string | null;
};
*/
/**
 * Send a text message to a guest on the appropriate channel.
 * Returns the provider response (or null in mock mode).
 **/
/*
export async function dispatchOutboundMessage(
  payload: OutboundPayload,
): Promise<unknown> {
  const channel = payload.channel ?? "whatsapp";

  switch (channel) {
    case "whatsapp":
      return waSendText({
        toPhone:   payload.toPhone,
        fromPhone: payload.fromPhone,
        hotelId:   payload.hotelId,
        guestId:   payload.guestId ?? null,
        text:      payload.text,
      });

    case "instagram":
      // TODO: implement when Instagram DM is live
      // return igSendText({ igUserId: payload.toPhone, hotelId: payload.hotelId, text: payload.text });
      console.warn("[Channel] Instagram dispatch not yet implemented");
      return null;

    case "sms":
      // TODO: implement when SMS channel is live
      // return smsSendText({ to: payload.toPhone, from: payload.fromPhone, text: payload.text });
      console.warn("[Channel] SMS dispatch not yet implemented");
      return null;

    default:
      console.warn(`[Channel] Unknown channel "${channel}" — dropping message`);
      return null;
  }
}
*/