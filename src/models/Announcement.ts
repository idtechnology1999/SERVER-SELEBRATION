import mongoose from 'mongoose';

const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  date: { type: String, default: () => new Date().toISOString().split('T')[0] },
}, { timestamps: true });

export const Announcement = mongoose.model('Announcement', announcementSchema);