import { Router } from 'express';
import type { Response } from 'express';
import { User, Commission, Withdrawal, Notification } from '../../models/index.js';
import { STAGE_LABELS, STAGE_NUMBERS, addOneMonth, isPaidUp, isStageKey } from '../../utils/stages.js';
import { disableSubscription } from '../../utils/paystack.js';
import { emit } from '../../socket.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const users = await User.find();
  res.json({ success: true, data: users });
}));

router.get('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  res.json({ success: true, data: user });
}));

router.put('/:id/ban', asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findByIdAndUpdate(req.params.id, { status: 'banned' }, { new: true });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  res.json({ success: true, data: user });
}));

router.put('/:id/unban', asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  res.json({ success: true, data: user });
}));

// Give a user a stage for a number of months without a Paystack payment
// (e.g. they paid by bank transfer). Body: { stage: 'fish' | 'dolphin' | 'shark' | 'whale', months: 1–12 }.
// No commissions are paid and it doesn't count as revenue, because no payment came through the site.
router.put('/:id/activate', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { stage } = req.body || {};
  const months = Number(req.body?.months ?? 1);
  if (!isStageKey(stage)) {
    res.status(400).json({ success: false, message: 'Choose a stage: fish, dolphin, shark or whale' });
    return;
  }
  if (!Number.isInteger(months) || months < 1 || months > 12) {
    res.status(400).json({ success: false, message: 'Months must be a whole number from 1 to 12' });
    return;
  }

  const existing = await User.findById(req.params.id);
  if (!existing) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  // Same stage while still paid up: add the months on top. Otherwise start today.
  const now = new Date();
  const stageNum = STAGE_NUMBERS[stage];
  let paidUntil = isPaidUp(existing, now) && stageNum === existing.stage && existing.paidUntil
    ? new Date(existing.paidUntil)
    : now;
  for (let i = 0; i < months; i++) paidUntil = addOneMonth(paidUntil);

  const user = await User.findByIdAndUpdate(req.params.id, {
    stage: stageNum,
    subscription: 'active',
    paidUntil,
    signupStatus: 'complete',
    pendingPayment: { reference: '', stage: '', renewal: '' },
  }, { new: true });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  const untilText = paidUntil.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  await Notification.create({
    userId: user._id.toString(), userType: 'student', type: 'system',
    title: `${STAGE_LABELS[stage]} plan activated`,
    message: `Your ${STAGE_LABELS[stage]} plan has been activated until ${untilText}.`,
  });
  emit('notification:new', { userId: user._id.toString() });

  res.json({ success: true, data: user });
}));

// Remove access straight away and stop any automatic card renewal.
router.put('/:id/cancel', asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await User.findById(req.params.id);
  if (!existing) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  if (existing.paystackSubscriptionCode) {
    const ok = await disableSubscription(existing.paystackSubscriptionCode, existing.paystackEmailToken).catch(() => false);
    if (!ok) {
      res.status(502).json({ success: false, message: "Couldn't stop their automatic renewal on Paystack. Please try again." });
      return;
    }
  }

  const user = await User.findByIdAndUpdate(req.params.id, {
    subscription: 'cancelled',
    renewal: 'manual',
    paystackSubscriptionCode: '',
    paystackEmailToken: '',
    paystackPlanCode: '',
  }, { new: true });
  res.json({ success: true, data: user });
}));

router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  // Also clean up related data
  await Commission.deleteMany({ $or: [{ payer: req.params.id }, { beneficiary: req.params.id }] });
  await Withdrawal.deleteMany({ user: req.params.id });
  res.json({ success: true, message: 'User deleted successfully' });
}));

export default router;
