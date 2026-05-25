import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  paystackKey: { type: String, default: '' },
  paystackSecret: { type: String, default: '' },
  paystackPlanId: { type: String, default: '' },
  bankName: { type: String, default: '' },
  bankAccount: { type: String, default: '' },
  bankAccountName: { type: String, default: '' },
  commissionLevel1: { type: Number, default: 65 },
  commissionLevel2: { type: Number, default: 15 },
  commissionLevel3: { type: Number, default: 5 },
  commissionLevel4: { type: Number, default: 3 },
  commissionLevel5: { type: Number, default: 2 },
  commissionLevel6: { type: Number, default: 1 },
  subscriptionPrice: { type: Number, default: 5000 },
  trialDays: { type: Number, default: 7 },
  minWithdrawal: { type: Number, default: 10000 },
  platformName: { type: String, default: 'Selliberation' },
  supportEmail: { type: String, default: '' },
  emailNotifications: { type: Boolean, default: true },
  withdrawalNotifications: { type: Boolean, default: true },
  commissionNotifications: { type: Boolean, default: true },
}, { timestamps: true });

export const Settings = mongoose.model('Settings', settingsSchema);
