import { Router } from 'express';
import type { Response } from 'express';
import { User, Commission, Withdrawal } from '../../models/index.js';
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

router.put('/:id/activate', asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findByIdAndUpdate(req.params.id, { subscription: 'active' }, { new: true });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  res.json({ success: true, data: user });
}));

router.put('/:id/cancel', asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findByIdAndUpdate(req.params.id, { subscription: 'cancelled' }, { new: true });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
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
