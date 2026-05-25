import { Router } from 'express';
import type { Response } from 'express';
import mongoose from 'mongoose';
import { User, Commission } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const PRICE = Number(process.env.SUBSCRIPTION_PRICE || 5000);

  const [users, commissions] = await Promise.all([
    User.find().sort({ createdAt: -1 }),
    Commission.find().sort({ createdAt: -1 }),
  ]);

  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.subscription === 'active').length;
  const trialUsers = users.filter(u => u.subscription === 'trial').length;
  const totalRevenue = activeUsers * PRICE;
  const conversionRate = totalUsers > 0 ? ((activeUsers / totalUsers) * 100).toFixed(1) : '0.0';
  const avgRevenuePerUser = totalUsers > 0 ? Math.round(totalRevenue / totalUsers) : 0;

  const now = new Date();
  const monthLabels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthLabels.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en', { month: 'short' }),
    });
  }

  const monthlyData = monthLabels.map(m => {
    const monthUsers = users.filter(u => {
      const d = new Date((u as any).createdAt || u.joined);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === m.key;
    });
    const conversions = monthUsers.filter(u => u.subscription === 'active').length;
    return {
      month: m.label,
      revenue: monthUsers.filter(u => u.subscription === 'active').length * PRICE,
      users: monthUsers.length,
      conversions,
    };
  });

  const commissionByLevel = [1, 2, 3, 4, 5, 6].map(level => ({
    level: `L${level}`,
    amount: commissions.filter(c => c.level === level).reduce((s, c) => s + c.amount, 0),
    count: commissions.filter(c => c.level === level).length,
  }));

  const topReferrers = users
    .filter(u => u.referrals > 0)
    .sort((a, b) => b.referrals - a.referrals)
    .slice(0, 10)
    .map(u => {
      const uid = mongoose.isValidObjectId(u._id) ? u._id.toString() : '';
      return {
        name: u.name || u.email,
        referrals: u.referrals,
        stage: u.stage,
        revenue: commissions
          .filter(c => c.beneficiary === uid)
          .reduce((s, c) => s + c.amount, 0),
      };
    });

  res.json({
    success: true,
    data: {
      kpis: {
        totalRevenue,
        totalUsers,
        conversionRate: parseFloat(conversionRate),
        avgRevenuePerUser,
        activeUsers,
        trialUsers,
      },
      monthlyData,
      commissionByLevel,
      topReferrers,
    },
  });
}));

export default router;
