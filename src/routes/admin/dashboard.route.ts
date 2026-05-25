import { Router } from 'express';
import type { Response } from 'express';
import mongoose from 'mongoose';
import { User, Withdrawal, Commission } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/stats', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const PRICE = Number(process.env.SUBSCRIPTION_PRICE || 5000);

  const [users, withdrawals, commissions] = await Promise.all([
    User.find().sort({ createdAt: -1 }),
    Withdrawal.find().sort({ createdAt: -1 }),
    Commission.find().sort({ createdAt: -1 }),
  ]);

  const activeCount    = users.filter(u => u.subscription === 'active').length;
  const trialCount     = users.filter(u => u.subscription === 'trial').length;
  const expiredCount   = users.filter(u => u.subscription === 'expired').length;
  const cancelledCount = users.filter(u => u.subscription === 'cancelled').length;

  const monthlyRevenue = activeCount * PRICE;

  const pendingWithdrawalTotal = withdrawals
    .filter(w => w.status === 'pending')
    .reduce((s, w) => s + w.amount, 0);

  const now = new Date();
  const monthLabels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthLabels.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en', { month: 'short' }),
    });
  }

  const userGrowth = monthLabels.map(m => {
    const count = users.filter(u => {
      const d = new Date((u as any).createdAt || u.joined);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return key === m.key;
    }).length;
    return { month: m.label, users: count, revenue: count * PRICE };
  });

  const commissionsByLevel = [1, 2, 3, 4, 5, 6].map(level => ({
    level: `L${level}`,
    amount: commissions.filter(c => c.level === level).reduce((s, c) => s + c.amount, 0),
  }));

  const recentUsers = users.slice(0, 5).map(u => ({
    name: u.name || u.email,
    email: u.email,
    date: u.joined,
    status: u.subscription,
  }));

  const recentPayments = users
    .filter(u => u.subscription === 'active')
    .slice(0, 5)
    .map(u => ({
      user: u.name || u.email,
      amount: PRICE,
      date: u.joined,
    }));

  const pendingWithdrawals = await Promise.all(
    withdrawals.filter(w => w.status === 'pending').slice(0, 10).map(async w => {
      let userName = w.user;
      let userEmail = '';
      if (mongoose.isValidObjectId(w.user)) {
        const u = await User.findById(w.user).select('name email');
        if (u) { userName = u.name || w.user; userEmail = u.email || ''; }
      }
      return {
        id: w._id.toString(),
        user: userName,
        email: userEmail,
        amount: w.amount,
        bankName: w.bankName,
        accountNumber: w.accountNumber,
        accountName: w.accountName,
      };
    })
  );

  res.json({
    success: true,
    data: {
      totalUsers: users.length,
      activeSubscribers: activeCount,
      monthlyRevenue,
      pendingWithdrawalTotal,
      subscriptionBreakdown: { active: activeCount, trial: trialCount, expired: expiredCount, cancelled: cancelledCount },
      userGrowth,
      commissionsByLevel,
      recentUsers,
      recentPayments,
      pendingWithdrawals,
    },
  });
}));

export default router;
