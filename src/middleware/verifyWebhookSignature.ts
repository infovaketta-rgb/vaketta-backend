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
      // TEMP DIAGNOSTIC (remove after debugging recurring "Invalid signature").
      // Identifies the SOURCE of each failed request (path, UA, IP) and confirms
      // which secret env var was used — values are NEVER logged, only the
      // first/last few hex chars of each signature so we can eyeball a mismatch.
      const recvPreview =
        signature.length > 20
          ? `${signature.slice(0, 14)}…${signature.slice(-6)}`
          : signature;
      const expPreview = `${expected.slice(0, 14)}…${expected.slice(-6)}`;
      console.warn(
        "[Webhook] Invalid signature",
        JSON.stringify({
          path:        req.originalUrl,
          method:      req.method,
          userAgent:   req.get("user-agent") ?? "(none)",
          ip:          req.ip,
          xForwardedFor: req.get("x-forwarded-for") ?? "(none)",
          secretEnv:       secretEnvName,       // which env var — NOT the value
          secretLen:       secret.length,      // trimmed length
          secretLenRaw:    appSecret.length,   // pre-trim (diff = trailing whitespace)
          rawBodyLen:  rawBody.length,
          received:    recvPreview,
          computed:    expPreview,
          lenMatch:    sigBuffer.length === expectedBuffer.length,
        })
      );

      return res.status(401).json({
        error:"Invalid webhook signature"
      });
    }

    next();
  };
}