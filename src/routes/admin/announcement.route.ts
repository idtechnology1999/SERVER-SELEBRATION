import { Router } from 'express';
import type { Response } from 'express';
import { Announcement, User, Notification } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const announcements = await Announcement.find().sort({ createdAt: -1 });
  res.json({ success: true, data: announcements });
}));

router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const announcement = new Announcement(req.body);
  await announcement.save();

  // Notify all students about new announcement
  const students = await User.find({ role: 'student' }).select('_id');
  console.log(`[Announcement] Found ${students.length} students to notify`);
  const notifications = students.map(s => ({
    userId: s._id.toString(),
    userType: 'student',
    title: 'New Announcement',
    message: announcement.title,
    type: 'announcement',
  }));
  if (notifications.length > 0) {
    const result = await Notification.insertMany(notifications);
    console.log(`[Announcement] Created ${result.length} notifications`);
  }

  res.status(201).json({ success: true, data: announcement });
}));

router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const announcement = await Announcement.findByIdAndDelete(req.params.id);
  if (!announcement) { res.status(404).json({ success: false, message: 'Announcement not found' }); return; }
  res.json({ success: true, message: 'Announcement deleted' });
}));

export default router;
