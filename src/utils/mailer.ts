import nodemailer, { Transporter } from "nodemailer";
import { logger } from "./logger";

const log = logger.child({ service: "mailer" });

// Lazily-created singleton transporter. Built from SMTP_* env vars.
let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    log.warn("SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing) — emails will be skipped");
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user, pass },
  });
  return transporter;
}

const FROM = process.env.SMTP_FROM ?? `Vaketta <${process.env.SMTP_USER ?? "no-reply@vaketta.com"}>`;
const APP_NAME = "Vaketta Chat";

/**
 * Send a password-reset OTP email. Throws if SMTP is not configured so the
 * caller can surface a clear error during setup; in production the env vars
 * are expected to be present.
 */
export async function sendOtpEmail(to: string, code: string, name?: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    // In dev without SMTP, log the code so the flow remains testable.
    log.warn({ to, code }, "SMTP not configured — OTP not emailed (dev fallback log)");
    throw new Error("Email service is not configured");
  }

  const greeting = name ? `Hi ${name},` : "Hi,";
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0C1B33">
      <h2 style="margin:0 0 12px;font-size:20px;color:#0C1B33">Reset your password</h2>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569">
        ${greeting} use the verification code below to reset your ${APP_NAME} password.
        This code expires in 10 minutes.
      </p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;
                  background:#F4F2ED;border:1px solid #E5E0D4;border-radius:12px;
                  padding:16px 0;margin:8px 0 16px;color:#1B52A8">${code}</div>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#94A3B8">
        If you didn't request this, you can safely ignore this email — your password won't change.
      </p>
    </div>`;

  try {
    const info = await t.sendMail({
      from:    FROM,
      to,
      subject: `${APP_NAME} password reset code: ${code}`,
      text:    `${greeting}\n\nYour ${APP_NAME} password reset code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
      html,
    });
    log.info(
      { to, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected },
      "OTP email sent",
    );
  } catch (err: any) {
    log.error(
      { to, err: err?.message, code: err?.code, command: err?.command, response: err?.response },
      "OTP email send failed",
    );
    throw err;
  }
}
