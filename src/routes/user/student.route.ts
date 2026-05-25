import { Router } from 'express';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import { requireUserAuth, type UserAuthRequest } from '../../middleware/userAuth.js';
import { User } from '../../models/User.js';
import { Commission } from '../../models/Commission.js';
import { Withdrawal } from '../../models/Withdrawal.js';
import { Course } from '../../models/Course.js';
import { ModuleUnlock } from '../../models/ModuleUnlock.js';
import { Notification } from '../../models/Notification.js';
import { Admin } from '../../models/Admin.js';
import { emit } from '../../socket.js';

const router = Router();
router.use(requireUserAuth);

router.get('/dashboard', async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const [user, commissions, withdrawals, courses] = await Promise.all([
      User.findById(userId).select('-password'),
      Commission.find({ beneficiary: userId }),
      Withdrawal.find({ user: userId }),
      Course.find({ status: 'active' }),
    ]);

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const totalEarned = commissions.reduce((s, c) => s + c.amount, 0);
    const pending = commissions.filter(c => c.status === 'pending').reduce((s, c) => s + c.amount, 0);
    const withdrawable = commissions.filter(c => c.status === 'withdrawable' || c.status === 'pending').reduce((s, c) => s + c.amount, 0);
    const withdrawn = commissions.filter(c => c.status === 'withdrawn').reduce((s, c) => s + c.amount, 0);

    res.json({
      success: true,
      data: {
        stats: { totalEarned, pending, withdrawable, withdrawn },
        referralCount: user.referrals,
        stage: user.stage,
        subscription: user.subscription,
        trialEndsAt: user.trialEndsAt,
        coursesCount: courses.length,
        pendingWithdrawals: withdrawals.filter(w => w.status === 'pending').length,
        courses: courses.slice(0, 3).map(c => ({
          id: c._id.toString(),
          name: (c as any).title || (c as any).name || '',
          thumbnail: c.thumbnail || '',
          modulesCount: c.stages.length,
        })),
      },
    });
  } catch (err: any) {
    console.error('[student dashboard error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/commissions', async (req: UserAuthRequest, res: Response) => {
  try {
    const commissions = await Commission.find({ beneficiary: req.user!.id }).sort({ createdAt: -1 });
    res.json({
      success: true,
      data: commissions.map(c => ({
        id: c._id.toString(),
        payerId: c.payer,
        courseId: c.course,
        level: c.level,
        amount: c.amount,
        status: c.status,
        createdAt: (c as any).createdAt,
      })),
    });
  } catch (err: any) {
    console.error('[student commissions error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/withdrawals', async (req: UserAuthRequest, res: Response) => {
  try {
    const withdrawals = await Withdrawal.find({ user: req.user!.id }).sort({ createdAt: -1 });
    res.json({
      success: true,
      data: withdrawals.map(w => ({
        id: w._id.toString(),
        amount: w.amount,
        bankName: w.bankName,
        accountNumber: w.accountNumber,
        accountName: w.accountName,
        status: w.status,
        adminNote: w.reason,
        createdAt: (w as any).createdAt,
      })),
    });
  } catch (err: any) {
    console.error('[student withdrawals error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/bank-account', async (req: UserAuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.id).select('bankName bankCode accountNumber accountName');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({
      success: true,
      data: {
        bankName: (user as any).bankName || '',
        bankCode: (user as any).bankCode || '',
        accountNumber: (user as any).accountNumber || '',
        accountName: (user as any).accountName || '',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/bank-account', async (req: UserAuthRequest, res: Response) => {
  try {
    const { bankName, bankCode, accountNumber, accountName } = req.body;
    if (!bankName || !bankCode || !accountNumber || !accountName) {
      res.status(400).json({ success: false, message: 'All bank account fields are required' });
      return;
    }
    await User.findByIdAndUpdate(req.user!.id, { bankName, bankCode, accountNumber, accountName });
    res.json({ success: true, message: 'Bank account saved successfully' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/withdrawals', async (req: UserAuthRequest, res: Response) => {
  try {
    const { amount } = req.body;
    if (!amount) {
      res.status(400).json({ success: false, message: 'Amount is required' });
      return;
    }

    const userId = req.user!.id;
    const user = await User.findById(userId).select('bankName bankCode accountNumber accountName');
    if (!user || !(user as any).accountNumber) {
      res.status(400).json({ success: false, message: 'Please save your bank account details first' });
      return;
    }

    const { bankName, bankCode, accountNumber, accountName } = user as any;

    const withdrawable = await Commission.find({ beneficiary: userId, status: { $in: ['pending', 'withdrawable'] } });
    const totalWithdrawable = withdrawable.reduce((s, c) => s + c.amount, 0);

    const MIN = 10000;
    if (totalWithdrawable < MIN) {
      res.status(400).json({ success: false, message: `Minimum withdrawal is ₦${MIN.toLocaleString()}` });
      return;
    }
    if (Number(amount) > totalWithdrawable) {
      res.status(400).json({ success: false, message: 'Amount exceeds your withdrawable balance' });
      return;
    }
    if (Number(amount) < MIN) {
      res.status(400).json({ success: false, message: `Minimum withdrawal is ₦${MIN.toLocaleString()}` });
      return;
    }

    const withdrawal = await Withdrawal.create({
      user: userId,
      amount: Number(amount),
      bankName,
      bankCode,
      accountNumber,
      accountName,
    });

    // Notify user
    await Notification.create({
      userId,
      userType: 'student',
      title: 'Withdrawal Request Submitted',
      message: `Your withdrawal request for ₦${Number(amount).toLocaleString()} is pending approval.`,
      type: 'system',
    });

    // Notify all admins
    const requestingUser = await User.findById(userId).select('name');
    const admins = await Admin.find().select('_id');
    if (admins.length > 0 && requestingUser) {
      await Notification.insertMany(admins.map(a => ({
        userId: a._id.toString(),
        userType: 'admin',
        title: 'New Withdrawal Request',
        message: `${requestingUser.name} has requested a withdrawal of ₦${Number(amount).toLocaleString()}.`,
        type: 'system',
      })));
      emit('notification:admin', { type: 'withdrawal_request' });
    }

    emit('withdrawal:updated', {
      id: withdrawal._id.toString(),
      status: 'pending',
      userId,
      amount: withdrawal.amount,
    });

    res.status(201).json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      data: { id: withdrawal._id.toString(), status: withdrawal.status },
    });
  } catch (err: any) {
    console.error('[student withdrawal create error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/referrals', async (req: UserAuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.id).select('referralCode referrals stage');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const directReferrals = await User.find({ referredBy: user.referralCode })
      .select('name email stage subscription joined createdAt')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        totalReferrals: user.referrals,
        stage: user.stage,
        directReferrals: directReferrals.map(r => ({
          id: r._id.toString(),
          name: r.name,
          email: r.email,
          stage: r.stage,
          subscription: r.subscription,
          joined: r.joined,
        })),
      },
    });
  } catch (err: any) {
    console.error('[student referrals error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Which stages a user can access based on their stage number
function accessibleStages(stage: number, subscription: string, trialEndsAt?: Date): string[] {
  const now = new Date();
  const trialActive = subscription === 'trial' && trialEndsAt && trialEndsAt > now;
  if (trialActive) return ['free'];
  if (subscription !== 'active') return [];
  if (stage >= 3) return ['free', 'fish', 'shark', 'whale'];
  if (stage >= 2) return ['free', 'fish', 'shark'];
  if (stage >= 1) return ['free', 'fish'];
  return ['free'];
}

router.get('/courses', async (req: UserAuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.id).select('subscription trialEndsAt stage');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const now = new Date();
    const trialActive = user.subscription === 'trial' && user.trialEndsAt && new Date(user.trialEndsAt) > now;
    const hasAccess = user.subscription === 'active' || trialActive;

    if (!hasAccess) {
      res.status(403).json({
        success: false,
        message: user.subscription === 'trial'
          ? 'Your free trial has expired. Please subscribe to continue.'
          : 'Please subscribe to access courses.',
      });
      return;
    }

    const unlocked = accessibleStages(user.stage ?? 0, user.subscription, user.trialEndsAt ? new Date(user.trialEndsAt) : undefined);
    const courses = await Course.find({ status: 'active' }).sort({ createdAt: -1 });

    res.json({
      success: true,
      unlockedStages: unlocked,
      data: courses.map(c => ({
        id: c._id.toString(),
        title: (c as any).title || '',
        thumbnail: c.thumbnail || '',
        description: c.description || '',
        whatYouLearn: (c as any).whatYouLearn || [],
        stages: (c as any).stages.map((s: any) => ({
          stage: s.stage,
          unlocked: unlocked.includes(s.stage),
          // Unlocked: full video data. Locked: titles only (no videoUrl)
          videos: unlocked.includes(s.stage)
            ? s.videos
            : s.videos.map((v: any) => ({ _id: v._id, title: v.title, description: '' })),
          videoCount: s.videos.length,
        })),
      })),
    });
  } catch (err: any) {
    console.error('[student courses error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/unlocked-modules', async (req: UserAuthRequest, res: Response) => {
  try {
    const { courseId } = req.query;
    if (!courseId || typeof courseId !== 'string') {
      res.status(400).json({ success: false, message: 'courseId is required' });
      return;
    }
    const unlocks = await ModuleUnlock.find({ userId: req.user!.id, courseId });
    res.json({ success: true, data: unlocks.map(u => u.moduleId) });
  } catch (err: any) {
    console.error('[unlocked-modules error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/profile', async (req: UserAuthRequest, res: Response) => {
  try {
    const { name, phone } = req.body;
    if (!name && !phone) {
      res.status(400).json({ success: false, message: 'Nothing to update' });
      return;
    }

    const updates: Record<string, string> = {};
    if (name) updates.name = name;
    if (phone) updates.phone = phone;

    const user = await User.findByIdAndUpdate(req.user!.id, updates, { new: true }).select('-password');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    res.json({ success: true, message: 'Profile updated', data: { name: user.name, phone: user.phone } });
  } catch (err: any) {
    console.error('[student profile update error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/change-password', async (req: UserAuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, message: 'Current and new password are required' });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
      return;
    }

    const user = await User.findById(req.user!.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      res.status(400).json({ success: false, message: 'Current password is incorrect' });
      return;
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err: any) {
    console.error('[student change-password error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
