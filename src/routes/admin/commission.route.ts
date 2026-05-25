import { Router } from 'express';
import type { Response } from 'express';
import { Commission } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const commissions = await Commission.find().sort({ createdAt: -1 });
  res.json({ success: true, data: commissions });
}));

export default router;
