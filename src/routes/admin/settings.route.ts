import { Router } from 'express';
import type { Request, Response } from 'express';
import { Settings } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();

// Public endpoint — returns only commission rates and subscription price
router.get('/public', asyncHandler(async (_req: Request, res: Response) => {
  const settings = await Settings.findOne().select(
    'commissionLevel1 commissionLevel2 commissionLevel3 commissionLevel4 commissionLevel5 commissionLevel6 subscriptionPrice trialDays'
  );
  const s = settings || {} as any;
  res.json({
    success: true,
    data: {
      commissionRates: [
        s.commissionLevel1 ?? 65,
        s.commissionLevel2 ?? 15,
        s.commissionLevel3 ?? 5,
        s.commissionLevel4 ?? 3,
        s.commissionLevel5 ?? 2,
        s.commissionLevel6 ?? 1,
      ],
      subscriptionPrice: s.subscriptionPrice ?? 5000,
      trialDays: s.trialDays ?? 7,
    },
  });
}));

// Admin-protected routes below
router.use(requireAuth);

router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  let settings = await Settings.findOne();
  if (!settings) { settings = new Settings({}); await settings.save(); }
  res.json({ success: true, data: settings });
}));

router.put('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  let settings = await Settings.findOne();
  if (settings) {
    Object.assign(settings, req.body);
    await settings.save();
  } else {
    settings = new Settings(req.body);
    await settings.save();
  }
  res.json({ success: true, data: settings });
}));

export default router;
