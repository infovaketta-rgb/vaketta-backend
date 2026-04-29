/**
 * call.controller.ts
 *
 * Voice call webhook scaffold — ready to wire up with Twilio or Exotel
 * when voice call integration is enabled for Vaketta hotels.
 *
 * To activate (Twilio example):
 *  1. npm install twilio
 *  2. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env
 *  3. Add per-hotel Twilio credentials to HotelConfig (migration required)
 *  4. Implement voice IVR flow or voicemail transcription service
 *  5. Uncomment the call route in app.ts
 *
 * Supported use-cases when live:
 *  - Missed call → send WhatsApp message to guest
 *  - Voicemail → transcribe → route through bot engine
 *  - IVR menu → mirror WhatsApp menu options via DTMF
 *
 * Twilio docs: https://www.twilio.com/docs/voice/webhooks
 * Exotel docs: https://developer.exotel.com/
 */

import { Request, Response } from "express";
import { logger } from "../utils/logger";

const log = logger.child({ service: "call" });

// ── Incoming call webhook (POST) ──────────────────────────────────────────────

export async function handleIncomingCall(req: Request, res: Response) {
  // Always respond immediately — Twilio/Exotel expect a TwiML/response body
  res.type("text/xml");

  try {
    const callerNumber = req.body?.From   as string | undefined;
    const hotelNumber  = req.body?.To     as string | undefined;
    const callSid      = req.body?.CallSid as string | undefined;

    log.info({ from: callerNumber, to: hotelNumber, callSid }, "incoming call");

    // TODO: implement when call channel is live
    // 1. Look up hotel by hotelNumber
    // 2. Check if within business hours (shouldAutoReply)
    // 3. If DAY → play IVR menu, collect DTMF input
    // 4. If NIGHT → play out-of-hours message, offer WhatsApp callback
    // 5. Log call as a Message record with messageType="call"

    // Placeholder: say a brief message and hang up
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    Thank you for calling. Please WhatsApp us for a faster response.
    Goodbye.
  </Say>
  <Hangup/>
</Response>`);

  } catch (err) {
    log.error({ err }, "incoming call webhook error");
    // Hang up gracefully on error
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup/></Response>`);
  }
}

// ── Missed call / voicemail webhook (POST) ────────────────────────────────────

export async function handleMissedCall(req: Request, res: Response) {
  res.sendStatus(200);

  try {
    const callerNumber = req.body?.From          as string | undefined;
    const hotelNumber  = req.body?.To            as string | undefined;
    const transcript   = req.body?.TranscriptionText as string | undefined;

    log.info({ from: callerNumber, to: hotelNumber, transcript: transcript?.slice(0, 100) }, "missed call / voicemail");

    // TODO: implement when call channel is live
    // 1. Look up hotel by hotelNumber
    // 2. Look up or create guest by callerNumber
    // 3. If transcript → run through bot engine as if it were a WhatsApp message
    // 4. Otherwise → send a "We missed your call, how can we help?" WhatsApp message
    // await sendWhatsAppMissedCallNotification(hotelId, callerNumber, transcript);

  } catch (err) {
    log.error({ err }, "missed call webhook error");
  }
}
