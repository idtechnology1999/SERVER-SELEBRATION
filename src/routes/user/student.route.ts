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
import { accessibleStages, paidUntilOf } from '../../utils/stages.js';
import { balanceFor, minWithdrawal } from '../../utils/payouts.js';

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

    // Earnings are released weekly (Thursday 10pm); only released money can be withdrawn.
    const balance = await balanceFor(userId);

    res.json({
      success: true,
      data: {
        stats: {
          totalEarned: balance.totalEarned,
          pending: balance.pending,
          withdrawable: balance.available,
          inWithdrawal: balance.inWithdrawal,
          withdrawn: balance.withdrawn,
        },
        nextPayoutAt: balance.nextReleaseAt,
        minWithdrawal: await minWithdrawal(),
        referralCount: user.referrals,
        stage: user.stage,
        subscription: user.subscription,
        trialEndsAt: user.subscription === 'trial' ? user.trialEndsAt : undefined,
        paidUntil: paidUntilOf(user),
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

    const requested = Math.floor(Number(amount));
    if (!Number.isFinite(requested) || requested <= 0) {
      res.status(400).json({ success: false, message: 'Please enter a valid amount' });
      return;
    }

    // One request at a time keeps the balance simple and stops double requests.
    if (await Withdrawal.exists({ user: userId, status: 'pending' })) {
      res.status(400).json({ success: false, message: 'You already have a withdrawal waiting for approval.' });
      return;
    }

    const { available } = await balanceFor(userId);
    const MIN = await minWithdrawal();
    if (available < MIN) {
      res.status(400).json({ success: false, message: `Minimum withdrawal is ₦${MIN.toLocaleString()}. Earnings are released every Thursday at 10pm.` });
      return;
    }
    if (requested > available) {
      res.status(400).json({ success: false, message: 'Amount exceeds your available balance' });
      return;
    }
    if (requested < MIN) {
      res.status(400).json({ success: false, message: `Minimum withdrawal is ₦${MIN.toLocaleString()}` });
      return;
    }

    const withdrawal = await Withdrawal.create({
      user: userId,
      amount: requested,
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

    // Older accounts may have no code: create one so their link always works.
    if (!user.referralCode) {
      for (let attempt = 0; attempt < 5 && !user.referralCode; attempt++) {
        const code = 'SELL-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        if (!(await User.exists({ referralCode: code }))) {
          user.referralCode = code;
          await user.save();
        }
      }
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

router.get('/courses', async (req: UserAuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.id).select('subscription trialEndsAt stage paidUntil');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    // Everyone sees the course list; stages they haven't paid for come back locked
    // (titles only), so the page can offer upgrade/renew buttons.
    const unlocked: string[] = accessibleStages(user);
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
