/**
 * Razorpay crypto + order creation.
 *
 * The signature verifiers are the entire security boundary of this integration:
 * a forged callback or webhook that verified would let anyone mark any invoice
 * paid. These tests pin the two schemes apart (different payloads, different
 * secrets) and cover the failure modes that are easy to get subtly wrong —
 * length mismatch, which makes `timingSafeEqual` THROW rather than return false.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  safeCompare,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  createRazorpayOrder,
  RazorpayNotConfiguredError,
  RazorpayApiError,
} from "./razorpay.service";

const KEY_SECRET = "test_key_secret_value";
const WEBHOOK_SECRET = "test_webhook_secret_value";

const hmac = (payload: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(payload).digest("hex");

const ORDER = "order_ABC123";
const PAYMENT = "pay_XYZ789";

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_fakekey";
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.MOCK_RAZORPAY;
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── safeCompare ──────────────────────────────────────────────────────────────

describe("safeCompare", () => {
  it("matches identical strings", () => {
    expect(safeCompare("abc123", "abc123")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(safeCompare("abc123", "abc124")).toBe(false);
  });

  it("returns false — never throws — on a LENGTH MISMATCH", () => {
    // crypto.timingSafeEqual throws on unequal buffer lengths. Without the
    // explicit guard this would be a 500 instead of a clean rejection.
    expect(() => safeCompare("short", "muchlongervalue")).not.toThrow();
    expect(safeCompare("short", "muchlongervalue")).toBe(false);
  });

  it("handles empty strings without throwing", () => {
    expect(safeCompare("", "")).toBe(true);
    expect(safeCompare("", "x")).toBe(false);
  });
});

// ── Checkout callback signature ──────────────────────────────────────────────

describe("verifyCheckoutSignature", () => {
  const valid = () => hmac(`${ORDER}|${PAYMENT}`, KEY_SECRET);

  it("accepts a correctly signed callback", () => {
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: valid() }),
    ).toBe(true);
  });

  it("REJECTS a tampered signature", () => {
    const sig = valid();
    const tampered = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: tampered }),
    ).toBe(false);
  });

  it("REJECTS a signature made with the WRONG SECRET", () => {
    const forged = hmac(`${ORDER}|${PAYMENT}`, "attacker_secret");
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: forged }),
    ).toBe(false);
  });

  it("REJECTS a signature made with the WEBHOOK secret (the schemes are distinct)", () => {
    const wrongScheme = hmac(`${ORDER}|${PAYMENT}`, WEBHOOK_SECRET);
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: wrongScheme }),
    ).toBe(false);
  });

  it("rejects a signature bound to a DIFFERENT order or payment", () => {
    const otherOrder = hmac(`order_OTHER|${PAYMENT}`, KEY_SECRET);
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: otherOrder }),
    ).toBe(false);

    const otherPayment = hmac(`${ORDER}|pay_OTHER`, KEY_SECRET);
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: otherPayment }),
    ).toBe(false);
  });

  it("rejects blank/missing fields instead of throwing", () => {
    for (const args of [
      { orderId: "", paymentId: PAYMENT, signature: valid() },
      { orderId: ORDER, paymentId: "", signature: valid() },
      { orderId: ORDER, paymentId: PAYMENT, signature: "" },
    ]) {
      expect(verifyCheckoutSignature(args)).toBe(false);
    }
  });

  it("rejects when no key secret is configured", () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: valid() }),
    ).toBe(false);
  });
});

// ── Webhook signature ────────────────────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: PAYMENT } } } });
  const valid = () => hmac(body, WEBHOOK_SECRET);

  it("accepts a correctly signed raw body", () => {
    expect(
      verifyWebhookSignature({ rawBody: body, signature: valid(), webhookSecret: WEBHOOK_SECRET }),
    ).toBe(true);
  });

  it("verifies over a Buffer identically to the equivalent string", () => {
    expect(
      verifyWebhookSignature({
        rawBody: Buffer.from(body, "utf8"),
        signature: valid(),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(true);
  });

  it("REJECTS a body altered by even one byte", () => {
    const altered = body.replace("payment.captured", "payment.capturee");
    expect(
      verifyWebhookSignature({ rawBody: altered, signature: valid(), webhookSecret: WEBHOOK_SECRET }),
    ).toBe(false);
  });

  it("REJECTS a signature made with the WRONG SECRET", () => {
    const forged = hmac(body, "attacker_secret");
    expect(
      verifyWebhookSignature({ rawBody: body, signature: forged, webhookSecret: WEBHOOK_SECRET }),
    ).toBe(false);
  });

  it("REJECTS a signature made with the KEY secret (the schemes are distinct)", () => {
    const wrongScheme = hmac(body, KEY_SECRET);
    expect(
      verifyWebhookSignature({ rawBody: body, signature: wrongScheme, webhookSecret: WEBHOOK_SECRET }),
    ).toBe(false);
  });

  it("REJECTS a re-stringified body — why the raw buffer must survive", () => {
    // Key order is not preserved by a parse/stringify round trip, which is
    // exactly why app.ts skips its JSON parser for /webhook/*.
    const reStringified = JSON.stringify(JSON.parse(body), ["payload", "event"]);
    expect(
      verifyWebhookSignature({
        rawBody: reStringified,
        signature: valid(),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a length-mismatched signature without throwing", () => {
    expect(() =>
      verifyWebhookSignature({ rawBody: body, signature: "deadbeef", webhookSecret: WEBHOOK_SECRET }),
    ).not.toThrow();
    expect(
      verifyWebhookSignature({ rawBody: body, signature: "deadbeef", webhookSecret: WEBHOOK_SECRET }),
    ).toBe(false);
  });

  it("rejects when the signature or secret is missing", () => {
    expect(verifyWebhookSignature({ rawBody: body, signature: "", webhookSecret: WEBHOOK_SECRET })).toBe(false);
    expect(verifyWebhookSignature({ rawBody: body, signature: valid(), webhookSecret: "" })).toBe(false);
  });
});

// ── Order creation ───────────────────────────────────────────────────────────

describe("createRazorpayOrder", () => {
  it("throws when Razorpay is not configured", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    await expect(
      createRazorpayOrder({ amount: 100, currency: "INR", receipt: "INV-1" }),
    ).rejects.toBeInstanceOf(RazorpayNotConfiguredError);
  });

  it("REFUSES a live key — this stage is test mode only", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_live_realkey";
    await expect(
      createRazorpayOrder({ amount: 100, currency: "INR", receipt: "INV-1" }),
    ).rejects.toThrow(/LIVE key/i);
  });

  it("rejects a non-integer or non-positive amount", async () => {
    for (const amount of [0, -100, 12.5, Number.NaN]) {
      await expect(
        createRazorpayOrder({ amount, currency: "INR", receipt: "INV-1" }),
      ).rejects.toThrow(/positive integer/i);
    }
  });

  it("returns a fixture in mock mode without calling the network", async () => {
    process.env.MOCK_RAZORPAY = "true";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const order = await createRazorpayOrder({ amount: 249900, currency: "INR", receipt: "INV-1" });

    expect(order.id).toMatch(/^order_MOCK/);
    expect(order.amount).toBe(249900);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends amount/currency/receipt and authenticates with Basic auth", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "order_REAL", amount: 249900, currency: "INR", status: "created" }),
    }));
    vi.stubGlobal("fetch", fetchSpy as any);

    const order = await createRazorpayOrder({
      amount: 249900,
      currency: "INR",
      receipt: "INV-2026-00001",
      notes: { invoiceId: "inv_1" },
    });

    expect(order.id).toBe("order_REAL");
    const [url, init] = fetchSpy.mock.calls[0] as any[];
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(init.headers.Authorization).toMatch(/^Basic /);
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ amount: 249900, currency: "INR", receipt: "INV-2026-00001" });
    expect(sent.notes).toEqual({ invoiceId: "inv_1" });
  });

  it("truncates an over-long receipt to Razorpay's 40-char cap", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "order_R", amount: 1, currency: "INR", status: "created" }),
    }));
    vi.stubGlobal("fetch", fetchSpy as any);

    await createRazorpayOrder({ amount: 1, currency: "INR", receipt: "X".repeat(60) });

    const sent = JSON.parse((fetchSpy.mock.calls[0] as any[])[1].body);
    expect(sent.receipt).toHaveLength(40);
  });

  it("surfaces a Razorpay API error as RazorpayApiError with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { description: "Invalid amount" } }),
      })) as any,
    );

    await expect(
      createRazorpayOrder({ amount: 100, currency: "INR", receipt: "INV-1" }),
    ).rejects.toMatchObject({ name: "RazorpayApiError", status: 400, message: "Invalid amount" });
  });

  it("does not throw a parse error when the failure body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, text: async () => "<html>gateway</html>" })) as any,
    );

    await expect(
      createRazorpayOrder({ amount: 100, currency: "INR", receipt: "INV-1" }),
    ).rejects.toBeInstanceOf(RazorpayApiError);
  });
});
