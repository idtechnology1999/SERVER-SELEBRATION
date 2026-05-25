import mongoose from 'mongoose';

const withdrawalSchema = new mongoose.Schema({
  user: { type: String, required: true },
  amount: { type: Number, required: true },
  bankName: { type: String, default: '' },
  bankCode: { type: String, default: '' },
  accountNumber: { type: String, default: '' },
  accountName: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  date: { type: String, default: () => new Date().toISOString().split('T')[0] },
  reason: String,
}, { timestamps: true });

export const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
