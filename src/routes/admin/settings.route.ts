import { Router } from 'express';
import type { Request, Response } from 'express';
import { Settings } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getStagePrices, parseStagePrices } from '../../utils/prices.js';
import { syncStagePlanPrices } from '../../utils/paystack.js';

const router = Router();

// Public endpoint — commission rates, stage prices and trial length (shown on the website)
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
      stagePrices: await getStagePrices(),
      trialDays: s.trialDays ?? 7,
    },
  });
}));

// Admin-protected routes below
router.use(requireAuth);

router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  let settings = await Settings.findOne();
  if (!settings) { settings = new Settings({}); await settings.save(); }
  // Always send all four prices (defaults filled in) so the admin form shows them.
  res.json({ success: true, data: { ...settings.toObject(), stagePrices: await getStagePrices() } });
}));

router.put('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  // Paystack plan codes are managed by the server, never by the form.
  const { stagePlans: _ignored, stagePrices: rawPrices, ...rest } = req.body || {};

  let newPrices;
  if (rawPrices !== undefined) {
    const parsed = parseStagePrices(rawPrices);
    if (!parsed.ok) { res.status(400).json({ success: false, message: parsed.message }); return; }
    newPrices = parsed.prices;
  }

  let settings = await Settings.findOne();
  if (!settings) settings = new Settings({});
  const before = await getStagePrices();

  Object.assign(settings, rest);
  if (newPrices) {
    settings.set('stagePrices', { ...(settings.get('stagePrices') || {}), ...newPrices });
    settings.markModified('stagePrices');
  }
  await settings.save();

  // Price changed: update auto-renew plans so renewals charge the new price.
  const after = await getStagePrices();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    syncStagePlanPrices().catch(err => console.error('[settings] plan price sync failed:', err.message));
  }

  res.json({ success: true, data: { ...settings.toObject(), stagePrices: after } });
}));

export default router;
