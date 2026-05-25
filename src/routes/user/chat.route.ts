import { Router } from 'express';
import type { Response } from 'express';
import { User } from '../../models/User.js';
import { ChatMessage } from '../../models/ChatMessage.js';
import { requireUserAuth, type UserAuthRequest } from '../../middleware/userAuth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getIO } from '../../socket.js';

const router = Router();

// GET /api/chat/messages — fetch this user's full conversation and mark admin messages read
router.get('/messages', requireUserAuth, asyncHandler(async (req: UserAuthRequest, res: Response) => {
  const messages = await ChatMessage.find({ conversationId: req.user!.id })
    .sort({ createdAt: 1 })
    .limit(200);

  await ChatMessage.updateMany(
    { conversationId: req.user!.id, senderType: 'admin', read: false },
    { read: true }
  );

  res.json({ success: true, data: messages });
}));

// POST /api/chat/send — user sends a message to admin
router.post('/send', requireUserAuth, asyncHandler(async (req: UserAuthRequest, res: Response) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ success: false, message: 'Message is required' });
    return;
  }
  if (message.trim().length > 2000) {
    res.status(400).json({ success: false, message: 'Message too long (max 2000 characters)' });
    return;
  }

  const user = await User.findById(req.user!.id).select('name');
  const senderName = user?.name || 'User';

  const msg = await ChatMessage.create({
    conversationId: req.user!.id,
    senderId: req.user!.id,
    senderType: 'user',
    senderName,
    message: message.trim(),
    read: false,
  });

  try {
    // Notify all admins in real-time
    getIO().to('admins').emit('chat:message', { conversationId: req.user!.id, message: msg });
    // Echo back to user's own room (confirms delivery)
    getIO().to(`user_${req.user!.id}`).emit('chat:message', { conversationId: req.user!.id, message: msg });
  } catch {}

  res.status(201).json({ success: true, data: msg });
}));

// GET /api/chat/unread-count — how many unread admin replies this user has
router.get('/unread-count', requireUserAuth, asyncHandler(async (req: UserAuthRequest, res: Response) => {
  const count = await ChatMessage.countDocuments({
    conversationId: req.user!.id,
    senderType: 'admin',
    read: false,
  });
  res.json({ success: true, data: { count } });
}));

export default router;
