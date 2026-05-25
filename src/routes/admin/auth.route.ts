import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Admin } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { sendMail } from '../../utils/mailer.js';

const router = Router();

const otpStore = new Map<string, { otp: string; expiresAt: number; attempts: number }>();

const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

router.post('/login', adminAuthLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password are required' });
      return;
    }

    const admin = await Admin.findOne({ email });
    if (!admin) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { id: admin._id.toString(), email: admin.email, role: admin.role },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      data: { id: admin._id.toString(), name: admin.name, email: admin.email, role: admin.role },
    });
  } catch (err: any) {
    console.error('[login error]', err.message);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const admin = await Admin.findById(req.admin!.id).select('-password');
    if (!admin) {
      res.status(404).json({ success: false, message: 'Admin not found' });
      return;
    }
    res.json({ success: true, data: { id: admin._id.toString(), name: admin.name, email: admin.email, role: admin.role } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/logout', (_req: Request, res: Response) => {
  res.json({ success: true, message: 'Logged out' });
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: 'Email is required' });
      return;
    }

    const admin = await Admin.findOne({ email });
    if (!admin) {
      res.status(404).json({ success: false, message: 'No admin account found with this email.' });
      return;
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

    await sendMail(email, 'Your Selebration Admin OTP', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0D2847;border-radius:12px;color:#fff;">
        <h2 style="color:#F5820A;margin-top:0;">Selebration Admin</h2>
        <p>Password reset requested for: <strong>${email}</strong></p>
        <p>Your one-time password:</p>
        <div style="font-size:48px;font-weight:bold;letter-spacing:12px;text-align:center;padding:24px;background:rgba(245,130,10,0.15);border-radius:8px;color:#F5820A;margin:16px 0;">
          ${otp}
        </div>
        <p style="color:#aaa;font-size:13px;">Expires in 10 minutes. Do not share this code.</p>
      </div>
    `);

    res.json({ success: true, message: `OTP sent to ${email}` });
  } catch (err: any) {
    console.error('[forgot-password error]', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      res.status(400).json({ success: false, message: 'Email, OTP, and new password are required' });
      return;
    }

    const stored = otpStore.get(email);
    if (!stored) {
      res.status(400).json({ success: false, message: 'No OTP found. Please request a new one.' });
      return;
    }
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(email);
      res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
      return;
    }
    stored.attempts += 1;
    if (stored.attempts > 5) {
      otpStore.delete(email);
      res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new OTP.' });
      return;
    }
    if (stored.otp !== otp) {
      res.status(400).json({ success: false, message: `Incorrect OTP. ${5 - stored.attempts} attempt${5 - stored.attempts === 1 ? '' : 's'} remaining.` });
      return;
    }

    otpStore.delete(email);
    const hashed = await bcrypt.hash(newPassword, 10);
    await Admin.findOneAndUpdate({ email }, { password: hashed });

    res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err: any) {
    console.error('[reset-password error]', err.message);
    res.status(500).json({ success: false, message: 'Server error during password reset' });
  }
});

export default router;
