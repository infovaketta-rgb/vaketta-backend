import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { decryptWhatsAppToken } from "../utils/encryption.utils";

const log = logger.child({ service: "whatsapp-send" });

// ── Credentials ───────────────────────────────────────────────────────────────

async function resolveCredentials(hotelId: string): Promise<{
  phoneNumberId: string;
  accessToken:   string;
  mockMode:      boolean;
}> {
  // All four credentials come exclusively from the hotel's WhatsApp integration form
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });

  const phoneNumberId = config?.metaPhoneNumberId ?? "";
  const encrypted     = config?.metaAccessTokenEncrypted ?? "";
  const accessToken   = encrypted ? decryptWhatsAppToken(encrypted) : "";

  const forceMock = process.env.MOCK_WHATSAPP_SEND === "true";

  if (forceMock) {
    log.warn({ hotelId }, "MOCK_WHATSAPP_SEND=true — not sending to Meta");
  } else if (!phoneNumberId || !accessToken) {
    log.warn({ hotelId }, "hotel has no Meta credentials configured — message will not be sent");
  }

  const mockMode = forceMock || !phoneNumberId || !accessToken;

  return { phoneNumberId, accessToken, mockMode };
}

// ── Retry helper ──────────────────────────────────────────────────────────────

/**
 * Retry a fetch-based operation with exponential backoff.
 * Retries on network errors and 5xx/429 HTTP responses.
 */
async function withRetry<T>(
  fn:      () => Promise<T>,
  retries = 3,
  baseMs  = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const isRetryable =
        // Network errors (no response)
        !err.status ||
        // Rate-limited or server error
        err.status === 429 ||
        err.status >= 500;

      if (!isRetryable || attempt === retries) throw err;

      const delay = baseMs * 2 ** attempt + Math.random() * 200;
      log.warn({ attempt: attempt + 1, delayMs: Math.round(delay) }, "Meta API attempt failed — retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Low-level Meta POST ───────────────────────────────────────────────────────

async function metaPost(
  endpoint:    string,
  body:        object,
  accessToken: string,
): Promise<any> {
  const res  = await fetch(`https://graph.facebook.com/v25.0/${endpoint}`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(15_000), // 15s hard timeout per attempt
  });
  const data = await res.json();
  if (!res.ok) {
    const err: any = new Error(`Meta API error ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Text message ──────────────────────────────────────────────────────────────

export async function sendTextMessage(input: {
  toPhone:   string;
  fromPhone: string;
  hotelId:   string;
  guestId?:  string | null;
  text:      string;
}) {
  const { toPhone, text, hotelId } = input;
  const { phoneNumberId, accessToken, mockMode } = await resolveCredentials(hotelId);

  if (mockMode) {
    log.info({ toPhone, preview: text.slice(0, 80) }, "MOCK TEXT send");
    return null;
  }

  return withRetry(() =>
    metaPost(`${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to:   toPhone,
      type: "text",
      text: { body: text },
    }, accessToken)
  );
}

// ── Carousel interactive message ──────────────────────────────────────────────

export interface CarouselCard {
  imageUrl:     string;
  title:        string;
  price:        number;
  description:  string;
  buttonId:     string;  // format: "room_{roomId}"
  /** Per-card override for the quick-reply button label. Max 20 chars (Meta limit).
   *  Falls back to "Select Room" if omitted. */
  buttonLabel?: string;
}

/**
 * Sends a WhatsApp Cloud API "interactive carousel" — a horizontally
 * scrollable strip of up to 10 cards, each with image header, body text,
 * footer, and a single quick-reply button. Used by the flow engine's
 * show_rooms node to render rooms visually instead of as a numbered text list.
 *
 * On success returns the wamid (Meta message id). Throws with a descriptive
 * message on failure.
 */
export async function sendCarouselMessage(
  toPhone:       string,
  phoneNumberId: string,
  accessToken:   string,
  bodyText:      string,
  cards:         CarouselCard[],
): Promise<string> {
  // Co-located mock guard. Matches sendTextMessage's behaviour so any caller
  // (current or future) gets dev/test safety without needing its own gate.
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") {
    log.info({ toPhone, cardCount: cards.length }, "MOCK CAROUSEL send");
    return "mock-wamid";
  }

  if (!cards.length) {
    throw new Error("sendCarouselMessage: at least one card is required");
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type:    "individual",
    to:                toPhone,
    type:              "interactive",
    interactive: {
      type: "carousel",
      body: { text: bodyText },
      action: {
        cards: cards.slice(0, 10).map((c, i) => ({
          card_index: i,
          type:       "cta_url",
          header:     { type: "image", image: { link: c.imageUrl } },
          body:       { text: `*${c.title}*\n₹${c.price}/night\n${c.description}` },
          action: {
            buttons: [{
              type: "quick_reply",
              quick_reply: {
                id:    c.buttonId,
                // Meta caps quick_reply.title at 20 chars — slice defensively
                // in case a caller didn't pre-validate.
                title: (c.buttonLabel ?? "Select Room").slice(0, 20),
              },
            }],
          },
        })),
      },
    },
  };

  log.info({ toPhone, cardCount: cards.length }, "sending carousel message");

  const data = await withRetry(() =>
    metaPost(`${phoneNumberId}/messages`, payload, accessToken)
  );

  const wamid = data?.messages?.[0]?.id;
  if (!wamid) {
    throw new Error(
      `sendCarouselMessage: Meta response missing message id: ${JSON.stringify(data)}`
    );
  }
  return wamid as string;
}

// ── Media message ─────────────────────────────────────────────────────────────

export async function sendMediaMessage(input: {
  toPhone:     string;
  hotelId:     string;
  messageType: string;
  mediaUrl:    string;
  mimeType:    string;
  fileName?:   string | null;
  caption?:    string | null;
}) {
  const { toPhone, hotelId, messageType, mediaUrl, mimeType, fileName, caption } = input;
  const { phoneNumberId, accessToken, mockMode } = await resolveCredentials(hotelId);

  if (mockMode) {
    log.info({ toPhone, messageType, mediaUrl }, "MOCK MEDIA send");
    return null;
  }

  if (!mediaUrl.startsWith("https://")) {
    throw new Error(`[WhatsApp] Invalid mediaUrl — expected a public R2 URL, got: ${mediaUrl}`);
  }

  // WhatsApp supported fields per type:
  // image    → link, caption
  // video    → link, caption
  // audio    → link (no caption, no filename)
  // document → link, caption, filename
  const mediaObject: Record<string, any> = { link: mediaUrl };

  if (caption && messageType !== "audio") {
    mediaObject.caption = caption;
  }

  if (fileName && messageType === "document") {
    mediaObject.filename = fileName;
  }

  log.info({ toPhone, messageType, mediaUrl, mimeType }, "sending media message");

  return withRetry(() =>
    metaPost(`${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to:   toPhone,
      type: messageType,
      [messageType]: mediaObject,
    }, accessToken)
  );
}
