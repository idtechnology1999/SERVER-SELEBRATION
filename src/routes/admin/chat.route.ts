import { Router } from 'express';
import type { Response } from 'express';
import { Admin } from '../../models/Admin.js';
import { User } from '../../models/User.js';
import { ChatMessage } from '../../models/ChatMessage.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getIO } from '../../socket.js';

const router = Router();

// GET /api/admin-chat/conversations — list all conversations with latest message + unread count
router.get('/conversations', requireAuth, asyncHandler(async (_req, res) => {
  const raw = await ChatMessage.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$conversationId',
        lastMessage: { $first: '$$ROOT' },
        userUnread: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$senderType', 'user'] }, { $eq: ['$read', false] }] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { 'lastMessage.createdAt': -1 } },
  ]);

  // Attach user name + email to each conversation
  const withUsers = await Promise.all(
    raw.map(async (conv) => {
      const user = await User.findById(conv._id).select('name email');
      return { ...conv, user: user ? { name: user.name, email: user.email } : null };
    })
  );

  res.json({ success: true, data: withUsers });
}));

// GET /api/admin-chat/messages/:userId — full thread, marks user messages as read
router.get('/messages/:userId', requireAuth, asyncHandler(async (req, res) => {
  const messages = await ChatMessage.find({ conversationId: req.params.userId })
    .sort({ createdAt: 1 })
    .limit(200);

  await ChatMessage.updateMany(
    { conversationId: req.params.userId, senderType: 'user', read: false },
    { read: true }
  );

  res.json({ success: true, data: messages });
}));

// POST /api/admin-chat/send/:userId — admin replies to a user
router.post('/send/:userId', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ success: false, message: 'Message is required' });
    return;
  }
  if (message.trim().length > 2000) {
    res.status(400).json({ success: false, message: 'Message too long (max 2000 characters)' });
    return;
  }

  const admin = await Admin.findById(req.admin!.id).select('name');
  const senderName = admin?.name || 'Support';

  const msg = await ChatMessage.create({
    conversationId: req.params.userId,
    senderId: req.admin!.id,
    senderType: 'admin',
    senderName,
    message: message.trim(),
    read: false,
  });

  try {
    // Deliver to the specific user in real-time
    getIO().to(`user_${req.params.userId}`).emit('chat:message', { conversationId: req.params.userId, message: msg });
    // Also broadcast to other admins so they see the reply in their Support page
    getIO().to('admins').emit('chat:message', { conversationId: req.params.userId, message: msg });
  } catch {}

  res.status(201).json({ success: true, data: msg });
}));

// GET /api/admin-chat/unread-count — total unread messages from all users
router.get('/unread-count', requireAuth, asyncHandler(async (_req, res) => {
  const count = await ChatMessage.countDocuments({ senderType: 'user', read: false });
  res.json({ success: true, data: { count } });
}));

export default router;
