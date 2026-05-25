import { Router } from 'express';
import type { Response } from 'express';
import { Notification } from '../../models/index.js';
import { requireUserAuth, type UserAuthRequest } from '../../middleware/userAuth.js';

const router = Router();
router.use(requireUserAuth);

// GET /api/student/notifications - Get student's notifications
router.get('/', async (req: UserAuthRequest, res: Response) => {
  try {
    const notifications = await Notification.find({
      userId: req.user!.id,
      userType: 'student',
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
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/student/notifications/:id/read - Mark notification as read
router.put('/:id/read', async (req: UserAuthRequest, res: Response) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user!.id, userType: 'student' },
      { read: true }
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
