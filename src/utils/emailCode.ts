import crypto from 'crypto';
import { User } from '../models/User.js';
import { sendMail } from './mailer.js';

const CODE_TTL_MS = 10 * 60 * 1000;   // a code works for 10 minutes
const RESEND_GAP_MS = 60 * 1000;      // at most one email per minute
const MAX_ATTEMPTS = 5;

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

export type SendResult = { sent: true } | { sent: false; retryAfterSeconds: number };

// Emails a fresh 6-digit code to confirm the account's email address.
export async function sendEmailCode(userId: string, { force = false } = {}): Promise<SendResult> {
  const user = await User.findById(userId).select('name email emailOtp');
  if (!user) throw new Error('User not found');

  const last = user.emailOtp?.lastSentAt ? new Date(user.emailOtp.lastSentAt).getTime() : 0;
  const wait = last + RESEND_GAP_MS - Date.now();
  if (!force && wait > 0) return { sent: false, retryAfterSeconds: Math.ceil(wait / 1000) };

  const code = String(crypto.randomInt(100000, 1000000));
  await User.findByIdAndUpdate(userId, {
    emailOtp: { hash: hashCode(code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0, lastSentAt: new Date() },
  });

  await sendMail(user.email, 'Confirm your Selliberation email', `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
      <h2 style="color:#0D2847;">Confirm your email</h2>
      <p>Hi <strong>${user.name}</strong>, thanks for your payment. Use this code to confirm your email and open your account:</p>
      <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid #F5820A;border-radius:10px;">
        <p style="margin:0;font-size:36px;font-weight:900;color:#F5820A;letter-spacing:8px;">${code}</p>
      </div>
      <p style="color:#888;font-size:13px;">This code expires in 10 minutes. If you did not sign up, ignore this email.</p>
    </div>
  `);
  return { sent: true };
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

export async function verifyEmailCode(userId: string, code: string): Promise<VerifyResult> {
  const user = await User.findById(userId).select('emailOtp emailVerified');
  if (!user) return { ok: false, message: 'Account not found' };
  if (user.emailVerified) return { ok: true };

  const otp = user.emailOtp;
  if (!otp?.hash || !otp.expiresAt || new Date(otp.expiresAt).getTime() < Date.now()) {
    return { ok: false, message: 'This code has expired. Tap "Resend code" to get a new one.' };
  }
  if ((otp.attempts ?? 0) >= MAX_ATTEMPTS) {
    return { ok: false, message: 'Too many incorrect attempts. Tap "Resend code" to get a new one.' };
  }

  const matches = crypto.timingSafeEqual(Buffer.from(hashCode(String(code).trim())), Buffer.from(otp.hash));
  if (!matches) {
    const attempts = (otp.attempts ?? 0) + 1;
    await User.findByIdAndUpdate(userId, { 'emailOtp.attempts': attempts });
    const left = MAX_ATTEMPTS - attempts;
    return { ok: false, message: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Tap "Resend code" to get a new one.' };
  }

  await User.findByIdAndUpdate(userId, {
    emailVerified: true,
    emailOtp: { hash: '', expiresAt: null, attempts: 0, lastSentAt: null },
  });
  return { ok: true };
}
