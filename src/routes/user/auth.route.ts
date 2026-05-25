import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { User } from '../../models/User.js';
import { requireUserAuth, type UserAuthRequest } from '../../middleware/userAuth.js';
import { emit } from '../../socket.js';
import { sendMail } from '../../utils/mailer.js';

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

// Helper: check and expire subscriptions that have passed their trialEndsAt
async function checkAndExpireSubscription(user: any): Promise<void> {
  if (user.subscription === 'active' || user.subscription === 'cancelled') return;
  if (user.trialEndsAt && new Date(user.trialEndsAt) < new Date()) {
    await User.findByIdAndUpdate(user._id, { subscription: 'expired' });
    user.subscription = 'expired';
  }
}

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
      await sendMail(email, 'Verify your Selebration email', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
          <h2 style="color:#0D2847;">Welcome to Selebration!</h2>
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

    const token = jwt.sign(
      { id: newUser._id.toString(), email: newUser.email, role: 'student' },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      token,
      data: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        referralCode: newUser.referralCode,
        stage: newUser.stage,
        subscription: newUser.subscription,
        trialEndsAt: newUser.trialEndsAt?.toISOString(),
      },
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

    // Check and expire trial/subscription if needed
    await checkAndExpireSubscription(user);

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, role: 'student' },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      data: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        referralCode: user.referralCode,
        stage: user.stage,
        subscription: user.subscription,
        trialEndsAt: user.trialEndsAt?.toISOString(),
      },
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

    res.json({
      success: true,
      data: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        referralCode: user.referralCode,
        stage: user.stage,
        subscription: user.subscription,
        trialEndsAt: user.trialEndsAt?.toISOString(),
      },
    });
  } catch (err: any) {
    console.error('[me error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /user-auth/logout
router.post('/logout', requireUserAuth, (_req: UserAuthRequest, res: Response) => {
  res.json({ success: true, message: 'Logged out' });
});

export default router;
