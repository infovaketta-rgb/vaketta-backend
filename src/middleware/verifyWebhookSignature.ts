import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Meta webhook signature verification middleware
 *
 * @param appSecret  the HMAC key (always FACEBOOK_APP_SECRET in this app)
 * @param secretEnvName  which env var the secret came from — logged on failure
 *                       for diagnostics (the VALUE is never logged).
 */
export function verifyWebhookSignature(
  appSecret:string,
  secretEnvName = "FACEBOOK_APP_SECRET"
){
  // Trim in case env var was copy-pasted with trailing whitespace/newline in Render dashboard
  const secret = appSecret.trim();

  if(!secret){
    throw new Error(
      "Webhook app secret missing"
    );
  }

  return function(
    req:Request,
    res:Response,
    next:NextFunction
  ){

    const signature =
      req.get(
        "x-hub-signature-256"
      );

    if(!signature){
      console.warn(
       "[Webhook] Missing signature"
      );

      return res.status(401).json({
        error:"Missing webhook signature"
      });
    }

    const rawBody =
      (req as any).rawBody as
      Buffer | undefined;

    if(!rawBody){
      return res.status(500).json({
        error:
         "Raw body unavailable for signature verification"
      });
    }

    const expected =
      "sha256=" +
      crypto
       .createHmac(
         "sha256",
         secret
       )
       .update(rawBody)
       .digest("hex");

    const sigBuffer=
      Buffer.from(
        signature,
        "utf8"
      );

    const expectedBuffer=
      Buffer.from(
        expected,
        "utf8"
      );

    if(
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(
        sigBuffer,
        expectedBuffer
      )
    ){
      // TEMP DIAGNOSTIC — remove once signature mismatch is resolved.
      const recvPreview =
        signature.length > 20
          ? `${signature.slice(0, 14)}…${signature.slice(-6)}`
          : signature;
      const expPreview = `${expected.slice(0, 14)}…${expected.slice(-6)}`;
      // First 32 + last 16 bytes of raw body as hex — enough to see if body is
      // compressed, double-encoded, or truncated without logging sensitive content.
      const bodyHead = rawBody.subarray(0, 32).toString("hex");
      const bodyTail = rawBody.subarray(-16).toString("hex");
      const bodyStr  = rawBody.toString("utf8", 0, 48); // first 48 chars as text
      console.warn(
        "[Webhook] Invalid signature",
        JSON.stringify({
          path:          req.originalUrl,
          method:        req.method,
          userAgent:     req.get("user-agent") ?? "(none)",
          ip:            req.ip,
          xForwardedFor: req.get("x-forwarded-for") ?? "(none)",
          contentType:   req.get("content-type") ?? "(none)",
          contentEncoding: req.get("content-encoding") ?? "(none)",
          secretEnv:     secretEnvName,
          secretLen:     secret.length,
          secretLenRaw:  appSecret.length,
          rawBodyLen:    rawBody.length,
          bodyHead,      // first 32 bytes as hex
          bodyTail,      // last 16 bytes as hex
          bodyStr,       // first 48 chars as text (shows if body is readable JSON or garbled)
          received:      recvPreview,
          computed:      expPreview,
          lenMatch:      sigBuffer.length === expectedBuffer.length,
        })
      );

      return res.status(401).json({
        error:"Invalid webhook signature"
      });
    }

    next();
  };
}