import { Router } from 'express';
import type { Request, Response } from 'express';
import { Notification } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';

const router = Router();

// GET /api/notifications - Get admin's notifications
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const notifications = await Notification.find({
      userId: req.admin!.id,
      userType: 'admin',
    }).sort({ createdAt: -1 }).limit(50);

    const data = notifications.map(n => ({
      id: n._id.toString(),
      title: n.title,
      message: n.message,
      type: n.type,
      read: n.read,
      createdAt: n.createdAt,
    }));

    res.json({ success: true, data });
  } catch (err: any) {
    console.error('[notifications error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/notifications/read-all - Mark all as read (must be before /:id route)
router.put('/read-all', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await Notification.updateMany(
      { userId: req.admin!.id, userType: 'admin' },
      { read: true }
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/notifications/:id/read - Mark notification as read
router.put('/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.admin!.id },
      { read: true }
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
