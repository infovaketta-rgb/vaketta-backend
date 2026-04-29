import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Meta webhook signature verification middleware
 */
export function verifyWebhookSignature(
  appSecret:string
){

  if(!appSecret){
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
         appSecret
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
      console.warn(
        "[Webhook] Invalid signature"
      );

      return res.status(401).json({
        error:"Invalid webhook signature"
      });
    }

    next();
  };
}