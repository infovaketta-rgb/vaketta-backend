import prisma from "../db/connect";

// ── Credentials ───────────────────────────────────────────────────────────────

async function resolveCredentials(hotelId: string): Promise<{
  phoneNumberId: string;
  accessToken:   string;
  mockMode:      boolean;
}> {
  // All four credentials come exclusively from the hotel's WhatsApp integration form
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });

  const phoneNumberId = config?.metaPhoneNumberId ?? "";
  const accessToken   = config?.metaAccessToken   ?? "";

  const forceMock = process.env.MOCK_WHATSAPP_SEND === "true";

  if (forceMock) {
    console.warn("[WhatsApp] MOCK_WHATSAPP_SEND=true — not sending to Meta");
  } else if (!phoneNumberId || !accessToken) {
    console.warn(`[WhatsApp] Hotel ${hotelId} has no Meta credentials configured — message will not be sent`);
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
      console.warn(`[Meta] Attempt ${attempt + 1} failed — retrying in ${Math.round(delay)}ms`);
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
    console.log("📤 MOCK TEXT →", toPhone, ":", text.slice(0, 80));
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
    console.log("📤 MOCK MEDIA →", toPhone, ":", messageType, mediaUrl);
    return null;
  }

  // All media is stored in R2 — mediaUrl must be a full public https:// URL
  if (!mediaUrl.startsWith("https://")) {
    throw new Error(`[WhatsApp] Invalid mediaUrl — expected a public R2 URL, got: ${mediaUrl}`);
  }

  console.log(`[WhatsApp] Sending ${messageType} to ${toPhone} — URL: ${mediaUrl} — MIME: ${mimeType}`);

  return withRetry(() =>
    metaPost(`${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to:   toPhone,
      type: messageType,
      [messageType]: {
        link:     mediaUrl,
        ...(caption  ? { caption }            : {}),
        ...(fileName ? { filename: fileName } : {}),
      },
    }, accessToken)
  );
}
