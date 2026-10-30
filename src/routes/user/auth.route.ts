import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { User } from '../../models/User.js';
import {
  requireUserAuth, requireSignupAuth, signUserToken, signSignupToken, type UserAuthRequest,
} from '../../middleware/userAuth.js';
import { emit } from '../../socket.js';
import { sendMail } from '../../utils/mailer.js';
import { publicUser } from '../../utils/publicUser.js';
import { sendEmailCode, verifyEmailCode } from '../../utils/emailCode.js';
import { resolvePendingSignup } from '../../utils/pendingSignup.js';
import { initStagePayment, FRONTEND_URL as PAYMENT_FRONTEND_URL } from '../../utils/paystack.js';
import { isPaidUp, isStageKey, stageKeyFromNumber } from '../../utils/stages.js';

// Pending registrations awaiting email OTP verification
const pendingRegistrations = new Map<string, {
  name: string; email: string; phone: string; password: string;
  referralCode?: string; otp: string; expiresAt: number; attempts: number;
}>();

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { success: false, message: 'Too many OTP attempts. Please try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

// Helper: mark a lapsed trial or paid month as expired
async function checkAndExpireSubscription(user: any): Promise<void> {
  if (user.subscription === 'cancelled' || user.subscription === 'expired') return;
  const lapsedTrial = user.subscription === 'trial' && user.trialEndsAt && new Date(user.trialEndsAt) < new Date();
  const lapsedPaid = user.subscription === 'active' && !isPaidUp(user);
  if (lapsedTrial || lapsedPaid) {
    await User.findByIdAndUpdate(user._id, { subscription: 'expired' });
    user.subscription = 'expired';
  }
}

const otpLimiterStrict = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = Router();

function generateReferralCode(): string {
  return 'SELL-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// POST /user-auth/register — send OTP, do NOT create account yet
router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { name, email, phone, password, referralCode } = req.body;

    if (!name || !email || !phone || !password) {
      res.status(400).json({ success: false, message: 'All fields are required' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      return;
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      res.status(400).json({ success: false, message: 'An account with this email already exists' });
      return;
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const hashedPassword = await bcrypt.hash(password, 10);

    pendingRegistrations.set(email.toLowerCase().trim(), {
      name, email: email.toLowerCase().trim(), phone, password: hashedPassword,
      referralCode, otp, expiresAt, attempts: 0,
    });

    try {
      await sendMail(email, 'Verify your Selliberation email', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
          <h2 style="color:#0D2847;">Welcome to Selliberation!</h2>
          <p>Hi <strong>${name}</strong>, use this code to verify your email and complete registration:</p>
          <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid #F5820A;border-radius:10px;">
            <p style="margin:0;font-size:36px;font-weight:900;color:#F5820A;letter-spacing:8px;">${otp}</p>
          </div>
          <p style="color:#888;font-size:13px;">This code expires in 10 minutes. If you did not request this, ignore this email.</p>
        </div>
      `);
    } catch {
      pendingRegistrations.delete(email.toLowerCase().trim());
      res.status(400).json({ success: false, message: 'Could not deliver email to that address. Please check your email and try again.' });
      return;
    }

    res.json({ success: true, message: 'Verification code sent to your email. Please check your inbox.' });
  } catch (err: any) {
    console.error('[register error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /user-auth/verify-email — verify OTP and create account
router.post('/verify-email', otpLimiter, async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      res.status(400).json({ success: false, message: 'Email and OTP are required' });
      return;
    }

    const pending = pendingRegistrations.get(email.toLowerCase().trim());
    if (!pending) {
      res.status(400).json({ success: false, message: 'No pending registration found. Please register again.' });
      return;
    }

    if (Date.now() > pending.expiresAt) {
      pendingRegistrations.delete(email.toLowerCase().trim());
      res.status(400).json({ success: false, message: 'Verification code has expired. Please register again.' });
      return;
    }

    // Limit OTP attempts per pending registration
    pending.attempts += 1;
    if (pending.attempts > 5) {
      pendingRegistrations.delete(email.toLowerCase().trim());
      res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please register again.' });
      return;
    }

    if (pending.otp !== otp) {
      res.status(400).json({ success: false, message: `Incorrect code. ${5 - pending.attempts} attempt${5 - pending.attempts === 1 ? '' : 's'} remaining.` });
      return;
    }

    // Double-check email not taken while OTP was pending
    const existing = await User.findOne({ email: pending.email });
    if (existing) {
      pendingRegistrations.delete(email.toLowerCase().trim());
      res.status(400).json({ success: false, message: 'This email was already registered.' });
      return;
    }

    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Resolve referrer
    let referredBy: string | null = null;
    if (pending.referralCode) {
      const referrer = await User.findOne({ referralCode: pending.referralCode });
      if (referrer) referredBy = pending.referralCode;
    }

    const newUser = await User.create({
      name: pending.name,
      email: pending.email,
      phone: pending.phone,
      password: pending.password,
      referralCode: generateReferralCode(),
      referredBy,
      trialEndsAt,
      subscription: 'trial',
    });

    pendingRegistrations.delete(email.toLowerCase().trim());

    emit('user:registered', { userId: newUser._id.toString(), name: newUser.name });

    res.status(201).json({
      success: true,
      token: signUserToken(newUser),
      data: publicUser(newUser),
    });
  } catch (err: any) {
    console.error('[verify-email error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /user-auth/login
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password are required' });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    if (user.status === 'banned') {
      res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    // Bought a plan but hasn't paid or confirmed the email yet: send them to finish sign-up
    // (payment check / email code) instead of the dashboard.
    if (user.signupStatus === 'awaiting_payment' || user.emailVerified === false) {
      res.json({
        success: true,
        signup: {
          token: signSignupToken(user),
          email: user.email,
          stage: user.pendingPayment?.stage || stageKeyFromNumber(user.stage ?? 0) || '',
        },
      });
      return;
    }

    // Check and expire trial/subscription if needed
    await checkAndExpireSubscription(user);

    res.json({
      success: true,
      token: signUserToken(user),
      data: publicUser(user),
    });
  } catch (err: any) {
    console.error('[login error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /user-auth/me
router.get('/me', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.id).select('-password');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    await checkAndExpireSubscription(user);

    res.json({ success: true, data: publicUser(user) });
  } catch (err: any) {
    console.error('[me error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /user-auth/logout
router.post('/logout', requireUserAuth, (_req: UserAuthRequest, res: Response) => {
  res.json({ success: true, message: 'Logged out' });
});

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

// POST /user-auth/forgot-password
router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: 'Email is required' });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always return success to prevent email enumeration
    if (!user) {
      res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await User.findByIdAndUpdate(user._id, {
      resetPasswordToken: token,
      resetPasswordExpiry: expiry,
    });

    const resetLink = `${FRONTEND_URL()}/reset-password?token=${token}`;

    await sendMail(user.email, 'Reset your Selliberation password', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
        <h2 style="color:#0D2847;">Reset your password</h2>
        <p>Hi <strong>${user.name}</strong>, we received a request to reset your Selliberation password.</p>
        <p>Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${resetLink}"
             style="display:inline-block;background:#F5820A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">
            Reset Password →
          </a>
        </div>
        <p style="color:#888;font-size:13px;">If you did not request a password reset, you can safely ignore this email.</p>
      </div>
    `);

    res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err: any) {
    console.error('[forgot-password error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /user-auth/reset-password
router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ success: false, message: 'Token and new password are required' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      return;
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpiry: { $gt: new Date() },
    });

    if (!user) {
      res.status(400).json({ success: false, message: 'This reset link is invalid or has expired.' });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);

    await User.findByIdAndUpdate(user._id, {
      password: hashed,
      resetPasswordToken: null,
      resetPasswordExpiry: null,
    });

    res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err: any) {
    console.error('[reset-password error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  Pay-first sign-up (plan buttons on the website)
//  1. register-paid: create an unconfirmed account and start the Paystack payment
//  2. signup/status: after Paystack, check the payment (paid / pending / failed → revoked)
//  3. signup/verify: enter the emailed code → logged in
// ════════════════════════════════════════════════════════════════════════════

// POST /user-auth/register-paid
router.post('/register-paid', authLimiter, async (req: Request, res: Response) => {
  try {
    const { name, email, phone, password, referralCode, stage, renewal } = req.body;

    if (!name || !email || !phone || !password) {
      res.status(400).json({ success: false, message: 'All fields are required' });
      return;
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      res.status(400).json({ success: false, message: 'Please enter a valid email address' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      return;
    }
    if (!isStageKey(stage)) {
      res.status(400).json({ success: false, message: 'Please choose a plan' });
      return;
    }
    if (renewal !== 'auto' && renewal !== 'manual') {
      res.status(400).json({ success: false, message: 'Please choose automatic or manual renewal' });
      return;
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: cleanEmail });
    if (existing) {
      // An earlier unpaid attempt with this email: settle it first (cancelled ones are revoked).
      const state = existing.signupStatus === 'awaiting_payment'
        ? await resolvePendingSignup(existing._id.toString())
        : 'paid';
      if (state === 'pending') {
        res.status(400).json({ success: false, message: 'A payment for this email is still being processed. Please wait a few minutes, then log in.' });
        return;
      }
      if (state === 'paid') {
        res.status(400).json({ success: false, code: 'EMAIL_EXISTS', message: 'An account with this email already exists. Please log in to continue.' });
        return;
      }
    }

    let referredBy: string | null = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer) referredBy = referralCode;
    }

    const newUser = await User.create({
      name: String(name).trim(),
      email: cleanEmail,
      phone: String(phone).trim(),
      password: await bcrypt.hash(String(password), 10),
      referralCode: generateReferralCode(),
      referredBy,
      subscription: 'expired',      // no free trial: access starts when the payment is confirmed
      emailVerified: false,
      signupStatus: 'awaiting_payment',
    });

    let payment;
    try {
      payment = await initStagePayment({
        email: cleanEmail,
        userId: newUser._id.toString(),
        stage,
        renewal,
        callbackUrl: `${PAYMENT_FRONTEND_URL()}/signup/complete`,
        signup: true,
      });
    } catch (err: any) {
      await User.deleteOne({ _id: newUser._id });
      console.error('[register-paid paystack error]', err.message);
      res.status(502).json({ success: false, message: 'Could not start the payment. Please try again.' });
      return;
    }

    await User.findByIdAndUpdate(newUser._id, {
      pendingPayment: { reference: payment.reference, stage, renewal },
    });

    res.status(201).json({
      success: true,
      data: {
        signupToken: signSignupToken(newUser),
        authorizationUrl: payment.authorizationUrl,
        reference: payment.reference,
      },
    });
  } catch (err: any) {
    console.error('[register-paid error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /user-auth/signup/status — called when the buyer returns from Paystack
router.get('/signup/status', requireSignupAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const before = await User.findById(req.user!.id).select('pendingPayment stage');
    if (!before) {
      res.json({ success: true, data: { state: 'failed' } });
      return;
    }
    const stage = before.pendingPayment?.stage || stageKeyFromNumber(before.stage ?? 0) || '';

    let state;
    try {
      state = await resolvePendingSignup(before._id.toString());
    } catch (err: any) {
      console.error('[signup status paystack error]', err.message);
      res.status(502).json({ success: false, message: "We couldn't check your payment right now. Please refresh in a moment." });
      return;
    }

    if (state !== 'paid') {
      res.json({ success: true, data: { state, stage } });
      return;
    }

    const user = await User.findById(before._id);
    if (!user) {
      res.json({ success: true, data: { state: 'failed', stage } });
      return;
    }
    if (!user.emailVerified) {
      await sendEmailCode(user._id.toString()).catch((err: any) => console.error('[signup code email error]', err.message));
    }
    res.json({
      success: true,
      data: { state: 'paid', stage, email: user.email, emailVerified: user.emailVerified !== false },
    });
  } catch (err: any) {
    console.error('[signup status error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /user-auth/signup/resend-code
router.post('/signup/resend-code', requireSignupAuth, otpLimiterStrict, async (req: UserAuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.id).select('signupStatus emailVerified');
    if (!user || user.signupStatus !== 'complete' || user.emailVerified) {
      res.status(400).json({ success: false, message: 'There is no code to send for this account.' });
      return;
    }
    const result = await sendEmailCode(user._id.toString());
    if (!result.sent) {
      res.status(429).json({ success: false, retryAfterSeconds: result.retryAfterSeconds, message: `Please wait ${result.retryAfterSeconds}s before requesting another code.` });
      return;
    }
    res.json({ success: true, message: 'A new code has been sent.' });
  } catch (err: any) {
    console.error('[resend-code error]', err.message);
    res.status(500).json({ success: false, message: 'Could not send the code. Please try again.' });
  }
});

// POST /user-auth/signup/change-email — fix a mistyped email before confirming it
router.post('/signup/change-email', requireSignupAuth, otpLimiterStrict, async (req: UserAuthRequest, res: Response) => {
  try {
    const { email } = req.body;
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      res.status(400).json({ success: false, message: 'Please enter a valid email address' });
      return;
    }
    const cleanEmail = email.toLowerCase().trim();

    const user = await User.findById(req.user!.id);
    if (!user || user.emailVerified) {
      res.status(400).json({ success: false, message: 'This email can no longer be changed here.' });
      return;
    }
    if (cleanEmail !== user.email && await User.exists({ email: cleanEmail })) {
      res.status(400).json({ success: false, message: 'That email is already used by another account.' });
      return;
    }

    user.email = cleanEmail;
    await user.save();

    if (user.signupStatus === 'complete') {
      await sendEmailCode(user._id.toString(), { force: true });
    }

    res.json({
      success: true,
      data: { email: cleanEmail, signupToken: signSignupToken(user) },
    });
  } catch (err: any) {
    console.error('[change-email error]', err.message);
    res.status(500).json({ success: false, message: 'Could not update the email. Please try again.' });
  }
});

// POST /user-auth/signup/verify — correct code → logged in
router.post('/signup/verify', requireSignupAuth, otpLimiterStrict, async (req: UserAuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ success: false, message: 'Please enter the 6-digit code' });
      return;
    }
    const user = await User.findById(req.user!.id).select('signupStatus');
    if (!user || user.signupStatus !== 'complete') {
      res.status(400).json({ success: false, message: 'Your payment has not been confirmed yet.' });
      return;
    }

    const result = await verifyEmailCode(user._id.toString(), String(code));
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.message });
      return;
    }

    const fresh = await User.findById(user._id).select('-password');
    if (!fresh) {
      res.status(404).json({ success: false, message: 'Account not found' });
      return;
    }
    emit('user:registered', { userId: fresh._id.toString(), name: fresh.name });

    res.json({ success: true, token: signUserToken(fresh), data: publicUser(fresh) });
  } catch (err: any) {
    console.error('[signup verify error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
