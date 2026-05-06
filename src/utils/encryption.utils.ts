import crypto from "crypto";

// ── Core AES-256-GCM primitives ───────────────────────────────────────────────

export function encrypt(text: string, keyHex: string): string {
  const key       = Buffer.from(keyHex, "hex");
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = cipher.update(text, "utf8", "hex") + cipher.final("hex");
  const tag       = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${encrypted}:${tag}`;
}

export function decrypt(payload: string, keyHex: string): string {
  const [ivHex, encrypted, tagHex] = payload.split(":");
  if (!ivHex || !encrypted || !tagHex) throw new Error("Invalid encrypted payload");
  const key      = Buffer.from(keyHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
}

// ── Instagram token helpers ───────────────────────────────────────────────────

function instagramKey(): string {
  const k = process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY;
  if (!k) throw new Error("Missing INSTAGRAM_TOKEN_ENCRYPTION_KEY");
  return k;
}

export const encryptInstagramToken = (token: string)   => encrypt(token,   instagramKey());
export const decryptInstagramToken = (payload: string) => decrypt(payload, instagramKey());

// ── WhatsApp token helpers ────────────────────────────────────────────────────

function whatsappKey(): string {
  const k = process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY;
  if (!k) throw new Error("Missing WHATSAPP_TOKEN_ENCRYPTION_KEY");
  return k;
}

export const encryptWhatsAppToken = (token: string)   => encrypt(token,   whatsappKey());
export const decryptWhatsAppToken = (payload: string) => decrypt(payload, whatsappKey());
