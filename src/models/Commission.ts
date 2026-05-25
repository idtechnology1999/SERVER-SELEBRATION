import mongoose from 'mongoose';

const commissionSchema = new mongoose.Schema({
  payer: { type: String, required: true },
  beneficiary: { type: String, required: true },
  level: { type: Number, required: true },
  amount: { type: Number, required: true },
  course: String,
  status: { type: String, enum: ['pending', 'withdrawable', 'withdrawn'], default: 'pending' },
  date: { type: String, default: () => new Date().toISOString().split('T')[0] },
}, { timestamps: true });

export const Commission = mongoose.model('Commission', commissionSchema);