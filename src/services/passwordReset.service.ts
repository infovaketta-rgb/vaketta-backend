import prisma from "../db/connect";
import { hashPassword, comparePassword } from "../utils/hash";
import { sendOtpEmail } from "../utils/mailer";
import { invalidateUserTokens } from "../utils/tokenBlocklist";
import { logger } from "../utils/logger";

const log = logger.child({ service: "password-reset" });

const OTP_TTL_MS      = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS    = 5;              // wrong-code guesses per OTP
const RESEND_COOLDOWN = 60 * 1000;      // min gap between OTP requests per user

function generateOtp(): string {
  // 6-digit numeric, zero-padded
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Step 1 — user requests a reset code for their email.
 * Always resolves without revealing whether the email exists (anti-enumeration).
 */
export async function requestPasswordResetService(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });

  // Silently succeed for unknown / disabled accounts — don't leak existence.
  if (!user || !user.isActive) {
    log.info({ email }, "reset requested for unknown/disabled account — no-op");
    return;
  }

  // Throttle: ignore if an unconsumed OTP was created very recently.
  const recent = await prisma.passwordResetOtp.findFirst({
    where: { userId: user.id, consumed: false },
    orderBy: { createdAt: "desc" },
  });
  if (recent && Date.now() - recent.createdAt.getTime() < RESEND_COOLDOWN) {
    log.info({ userId: user.id }, "reset request within cooldown — skipping new OTP");
    return;
  }

  const code = generateOtp();
  const codeHash = await hashPassword(code);

  // Invalidate any prior pending codes, then store the new one.
  await prisma.passwordResetOtp.updateMany({
    where: { userId: user.id, consumed: false },
    data:  { consumed: true },
  });
  await prisma.passwordResetOtp.create({
    data: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });

  await sendOtpEmail(user.email, code, user.name);
}

/**
 * Step 2 — verify the OTP and set a new password.
 * Throws a friendly Error on any failure (expired/invalid/too many attempts).
 */
export async function resetPasswordService(
  email: string,
  code: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error("Invalid or expired code");

  const otp = await prisma.passwordResetOtp.findFirst({
    where: { userId: user.id, consumed: false },
    orderBy: { createdAt: "desc" },
  });

  if (!otp) throw new Error("Invalid or expired code");

  if (otp.expiresAt.getTime() < Date.now()) {
    await prisma.passwordResetOtp.update({ where: { id: otp.id }, data: { consumed: true } });
    throw new Error("This code has expired. Please request a new one.");
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    await prisma.passwordResetOtp.update({ where: { id: otp.id }, data: { consumed: true } });
    throw new Error("Too many incorrect attempts. Please request a new code.");
  }

  const match = await comparePassword(code, otp.codeHash);
  if (!match) {
    await prisma.passwordResetOtp.update({
      where: { id: otp.id },
      data:  { attempts: { increment: 1 } },
    });
    throw new Error("Invalid or expired code");
  }

  // Success — update password, consume the OTP, revoke existing sessions.
  const hashed = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { password: hashed } }),
    prisma.passwordResetOtp.update({ where: { id: otp.id }, data: { consumed: true } }),
  ]);

  await invalidateUserTokens(user.id);
  log.info({ userId: user.id }, "password reset via OTP");
}
