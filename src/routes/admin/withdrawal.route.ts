import { Router } from 'express';
import type { Response } from 'express';
import { Withdrawal, Notification } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { emit } from '../../socket.js';

const router = Router();
router.use(requireAuth);

router.get('/pending-count', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const count = await Withdrawal.countDocuments({ status: 'pending' });
  res.json({ success: true, data: { count } });
}));

router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const withdrawals = await Withdrawal.find().sort({ createdAt: -1 });
  res.json({ success: true, data: withdrawals });
}));

router.put('/:id/approve', asyncHandler(async (req: AuthRequest, res: Response) => {
  // Only a pending request can be approved (stops approving the same one twice).
  const withdrawal = await Withdrawal.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { status: 'approved' },
    { new: true },
  );
  if (!withdrawal) { res.status(404).json({ success: false, message: 'Pending withdrawal not found' }); return; }

  // Balances are worked out from withdrawals, so only the approved amount is paid out;
  // the rest of the user's earnings stay available.

  // Notify user
  await Notification.create({
    userId: withdrawal.user,
    userType: 'student',
    title: 'Withdrawal Approved',
    message: `Your withdrawal of ₦${withdrawal.amount.toLocaleString()} has been approved and paid to ${withdrawal.bankName} ${withdrawal.accountNumber}.`,
    type: 'system',
  });

  // Notify admin
  await Notification.create({
    userId: req.admin!.id,
    userType: 'admin',
    title: 'Withdrawal Paid',
    message: `Withdrawal of ₦${withdrawal.amount.toLocaleString()} marked as paid.`,
    type: 'system',
  });

  emit('withdrawal:updated', { id: withdrawal._id.toString(), status: 'approved' });
  res.json({ success: true, data: withdrawal });
}));

router.put('/:id/reject', asyncHandler(async (req: AuthRequest, res: Response) => {
  const withdrawal = await Withdrawal.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { status: 'rejected', reason: req.body.reason || 'Rejected by admin' },
    { new: true }
  );
  if (!withdrawal) { res.status(404).json({ success: false, message: 'Pending withdrawal not found' }); return; }
  
  // Notify user
  await Notification.create({
    userId: withdrawal.user,
    userType: 'student',
    title: 'Withdrawal Rejected',
    message: `Your withdrawal of ₦${withdrawal.amount.toLocaleString()} was rejected. Reason: ${req.body.reason || 'Please contact support.'}`,
    type: 'system',
  });

  emit('withdrawal:updated', { id: withdrawal._id.toString(), status: 'rejected' });
  res.json({ success: true, data: withdrawal });
}));

export default router;
