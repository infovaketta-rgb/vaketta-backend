/**
 * services/razorpay.service.ts
 *
 * The Razorpay HTTP + crypto boundary. Everything in this file talks to
 * Razorpay or verifies something Razorpay signed; no billing logic lives here.
 *
 * NO SDK. The repo already makes 26 outbound calls with native `fetch` and has
 * no HTTP client dependency; the Orders API is one authenticated POST, and the
 * signature schemes are two HMACs. Adding the `razorpay` package to obtain that
 * would be a dependency for no capability.
 *
 * TWO DIFFERENT SIGNATURE SCHEMES - conflating them is the classic bug:
 *
 *   Checkout callback : HMAC_SHA256(`${order_id}|${payment_id}`, KEY_SECRET)
 *   Webhook           : HMAC_SHA256(rawRequestBody,              WEBHOOK_SECRET)
 *
 * Different payloads AND different secrets. Both are bare lowercase hex - no
 * `sha256=` prefix, unlike Meta's `x-hub-signature-256`, which is why
 * `middleware/verifyWebhookSignature.ts` could not simply be reused.
 *
 * Nothing here logs a secret, a signature, or a request body.
 */
import crypto from "crypto";
import {
  assertTestMode,
  getRazorpayConfig,
  isRazorpayMocked,
  type RazorpayConfig,
} from "../config/razorpay.config";
import { logger } from "../utils/logger";

const log = logger.child({ service: "razorpay" });

const RAZORPAY_API = "https://api.razorpay.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;

export class RazorpayNotConfiguredError extends Error {
  constructor() {
    super("Razorpay is not configured");
    this.name = "RazorpayNotConfiguredError";
  }
}

export class RazorpayApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RazorpayApiError";
    this.status = status;
  }
}

/**
 * Constant-time signature comparison.
 *
 * `timingSafeEqual` THROWS when the two buffers differ in length, so the length
 * check is not merely an optimisation - without it a malformed signature
 * produces a 500 instead of a clean rejection. Same guard shape as
 * `middleware/verifyWebhookSignature.ts`.
 *
 * Both sides are compared as ASCII hex rather than decoded bytes so a
 * non-hex signature can never throw inside Buffer.from.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hmacHex(payload: string | Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify a Standard Checkout success callback.
 *
 * The browser hands us `{razorpay_order_id, razorpay_payment_id,
 * razorpay_signature}`. Anyone can POST that shape, so the signature is the only
 * thing separating a real payment from a forged one - and it is verified with
 * KEY_SECRET, which never leaves the server.
 *
 * Returns false (never throws) for missing/blank fields so a malformed callback
 * is a 400, not a 500.
 */
export function verifyCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret?: string;
}): boolean {
  const { orderId, paymentId, signature } = input;
  if (!orderId || !paymentId || !signature) return false;

  const keySecret = input.keySecret ?? getRazorpayConfig()?.keySecret;
  if (!keySecret) return false;

  return safeCompare(hmacHex(`${orderId}|${paymentId}`, keySecret), signature);
}

/**
 * Verify a webhook against the RAW request body.
 *
 * MUST be the exact bytes Razorpay sent. A body that has been parsed and
 * re-stringified will not match - key ordering and whitespace are not preserved
 * by `JSON.stringify`. `app.ts` skips its JSON parser for `/webhook/*` precisely
 * so this buffer survives intact.
 */
export function verifyWebhookSignature(input: {
  rawBody: Buffer | string;
  signature: string;
  webhookSecret: string;
}): boolean {
  const { rawBody, signature, webhookSecret } = input;
  if (!signature || !webhookSecret || rawBody == null) return false;

  return safeCompare(hmacHex(rawBody, webhookSecret), signature);
}

export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string | null;
};

export type CreateOrderInput = {
  /** Integer minor units (paise). Always server-derived from the invoice. */
  amount: number;
  currency: string;
  /** Human reference - the invoice number. Razorpay caps this at 40 chars. */
  receipt: string;
  /** Reconciliation breadcrumbs. NEVER trusted on the way back in. */
  notes?: Record<string, string>;
};

/**
 * Create a Razorpay Order.
 *
 * `notes` are written for human reconciliation in the Razorpay dashboard only.
 * They are attacker-influencable in principle and are NEVER read back to decide
 * which invoice or hotel a payment belongs to - that always comes from a local
 * `Invoice.providerOrderId` lookup. See razorpayPayment.service.
 */
export async function createRazorpayOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
  const config = getRazorpayConfig();
  if (!config) throw new RazorpayNotConfiguredError();
  assertTestMode(config.keyId);

  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("Razorpay order amount must be a positive integer in minor units");
  }

  if (isRazorpayMocked()) {
    return {
      id: `order_MOCK${crypto.randomBytes(6).toString("hex")}`,
      amount: input.amount,
      currency: input.currency,
      status: "created",
      receipt: input.receipt,
    };
  }

  const res = await postJson(config, "/orders", {
    amount: input.amount,
    currency: input.currency,
    receipt: input.receipt.slice(0, 40),
    payment_capture: 1,
    ...(input.notes ? { notes: input.notes } : {}),
  });

  return {
    id: String(res.id),
    amount: Number(res.amount),
    currency: String(res.currency),
    status: String(res.status),
    receipt: res.receipt ? String(res.receipt) : null,
  };
}

/**
 * Fetch a payment from Razorpay.
 *
 * Used to re-confirm amount/status server-side rather than trusting a payload
 * alone when something looks inconsistent. Returns null on any failure -
 * callers treat it as "cannot corroborate" and fall back to the signed payload.
 */
export async function fetchRazorpayPayment(paymentId: string): Promise<{
  id: string;
  amount: number;
  currency: string;
  status: string;
  orderId: string | null;
} | null> {
  const config = getRazorpayConfig();
  if (!config || isRazorpayMocked()) return null;

  try {
    const res = await getJson(config, `/payments/${encodeURIComponent(paymentId)}`);
    return {
      id: String(res.id),
      amount: Number(res.amount),
      currency: String(res.currency),
      status: String(res.status),
      orderId: res.order_id ? String(res.order_id) : null,
    };
  } catch (err) {
    log.warn({ err, paymentId }, "could not fetch payment from Razorpay");
    return null;
  }
}

/** HTTP Basic with key_id:key_secret - Razorpay's documented server auth. */
function authHeader(config: RazorpayConfig): string {
  return "Basic " + Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64");
}

async function postJson(config: RazorpayConfig, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${RAZORPAY_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader(config) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return readResponse(res, path);
}

async function getJson(config: RazorpayConfig, path: string): Promise<any> {
  const res = await fetch(`${RAZORPAY_API}${path}`, {
    method: "GET",
    headers: { Authorization: authHeader(config) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return readResponse(res, path);
}

async function readResponse(res: Response, path: string): Promise<any> {
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    // Razorpay's error description is safe to surface (it never echoes the key);
    // the raw body is not logged.
    const description = parsed?.error?.description ?? `Razorpay request failed (${res.status})`;
    log.error({ status: res.status, path, description }, "razorpay api error");
    throw new RazorpayApiError(String(description), res.status);
  }

  return parsed ?? {};
}
