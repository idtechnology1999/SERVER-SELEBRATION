import mongoose from 'mongoose';

const chatMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, index: true }, // userId is the conversation key
    senderId: { type: String, required: true },
    senderType: { type: String, enum: ['user', 'admin'], required: true },
    senderName: { type: String, required: true },
    message: { type: String, required: true, maxlength: 2000 },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
