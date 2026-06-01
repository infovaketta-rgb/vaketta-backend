import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { decryptWhatsAppToken } from "../utils/encryption.utils";

const log = logger.child({ service: "whatsapp-send" });

// ── Credentials ───────────────────────────────────────────────────────────────

// Resolving credentials used to hit the DB (hotelConfig.findUnique) + decrypt the
// token on EVERY outbound message. Credentials change rarely, so we cache the
// DB-derived part per hotel with a short TTL — saving a query + a decrypt on the
// hot reply path. Mutations call invalidateCredentialsCache() so a rotated token
// takes effect immediately; otherwise it self-heals within CRED_TTL_MS.
const CRED_TTL_MS = 60_000;
type CachedCreds = { phoneNumberId: string; accessToken: string; expiresAt: number };
const credCache = new Map<string, CachedCreds>();

/** Drop cached WhatsApp credentials so the next send re-reads them from the DB.
 *  Call after persisting new metaPhoneNumberId / metaAccessTokenEncrypted. */
export function invalidateCredentialsCache(hotelId?: string): void {
  if (hotelId) credCache.delete(hotelId);
  else credCache.clear();
}

async function resolveCredentials(hotelId: string): Promise<{
  phoneNumberId: string;
  accessToken:   string;
  mockMode:      boolean;
}> {
  let cached = credCache.get(hotelId);
  if (!cached || cached.expiresAt <= Date.now()) {
    // Credentials come exclusively from the hotel's WhatsApp integration form.
    const config = await prisma.hotelConfig.findUnique({
      where:  { hotelId },
      select: { metaPhoneNumberId: true, metaAccessTokenEncrypted: true },
    });
    const phoneNumberId = config?.metaPhoneNumberId ?? "";
    const encrypted     = config?.metaAccessTokenEncrypted ?? "";
    const accessToken   = encrypted ? decryptWhatsAppToken(encrypted) : "";
    cached = { phoneNumberId, accessToken, expiresAt: Date.now() + CRED_TTL_MS };
    credCache.set(hotelId, cached);
  }

  const { phoneNumberId, accessToken } = cached;
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

/**
 * Exported retry wrapper for Meta API calls. Linear backoff: attempt * 1000ms.
 * Retries on network errors, 429, and 5xx responses.
 */
export async function withMetaRetry<T>(
  fn:          () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const isRetryable = !err.status || err.status === 429 || err.status >= 500;
      if (!isRetryable || attempt === maxAttempts - 1) throw err;
      const delay = (attempt + 1) * 1_000;
      log.warn({ attempt: attempt + 1, delayMs: delay }, "Meta API attempt failed — retrying");
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
 * footer, and 2 quick-reply buttons: one to select the room, one to view
 * its photos. Used by the flow engine's show_rooms node.
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
            buttons: [
              {
                type: "quick_reply",
                quick_reply: {
                  id:    c.buttonId,
                  // Meta caps quick_reply.title at 20 chars — slice defensively
                  title: (c.buttonLabel ?? "Select Room").slice(0, 20),
                },
              },
              {
                type: "quick_reply",
                quick_reply: {
                  // buttonId is "room_<roomId>"; derive "photos_<roomId>"
                  id:    `photos_${c.buttonId.replace(/^room_/, "")}`,
                  title: "View Photos",
                },
              },
            ],
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

// ── Interactive list message ──────────────────────────────────────────────────

export interface ListSection {
  title: string;
  rows:  Array<{ id: string; title: string; description?: string }>;
}

/**
 * Sends a WhatsApp Cloud API "interactive list" message — a bottom-sheet picker
 * the guest opens by tapping a button. Meta collapses the guest's tap into a
 * list_reply with the selected row id, which the webhook handler already
 * synthesises to a plain text body (see whatsapp.controller.ts line ~142).
 *
 * Returns the wamid on success. Throws on failure.
 */
export async function sendListMessage(
  toPhone:       string,
  phoneNumberId: string,
  accessToken:   string,
  opts: {
    bodyText:    string;
    footerText?: string;
    buttonLabel: string;
    sections:    ListSection[];
  },
): Promise<string> {
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") {
    log.info({ toPhone, rowCount: opts.sections.reduce((n, s) => n + s.rows.length, 0) }, "MOCK LIST send");
    return "mock-wamid";
  }

  const interactive: Record<string, unknown> = {
    type:   "list",
    body:   { text: opts.bodyText },
    action: {
      button:   opts.buttonLabel,
      sections: opts.sections.map((sec) => ({
        title: sec.title,
        rows:  sec.rows.map((r) => ({
          id:    r.id,
          title: r.title.slice(0, 24),
          ...(r.description ? { description: r.description.slice(0, 72) } : {}),
        })),
      })),
    },
  };

  if (opts.footerText) {
    interactive["footer"] = { text: opts.footerText };
  }

  log.info({ toPhone, sections: opts.sections.length }, "sending list message");

  const data = await withRetry(() =>
    metaPost(`${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to:                toPhone,
      type:              "interactive",
      interactive,
    }, accessToken)
  );

  const wamid = data?.messages?.[0]?.id;
  if (!wamid) {
    throw new Error(`sendListMessage: Meta response missing message id: ${JSON.stringify(data)}`);
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
