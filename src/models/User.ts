import mongoose from 'mongoose';

const referralNodeSchema = new mongoose.Schema({
  id: String,
  name: String,
  stage: Number,
  subscription: String,
  referrals: Number,
  level: Number,
  children: [{ id: String, name: String, stage: Number, subscription: String, referrals: Number, level: Number }],
}, { _id: false });

const userSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone:        { type: String, required: true },
  password:     { type: String, required: true },
  role:         { type: String, enum: ['student', 'affiliate', 'admin'], default: 'student' },
  referralCode: { type: String, unique: true },
  referredBy:   { type: String, default: null },   // referral code of who referred them
  stage:        { type: Number, default: 0 },
  referrals:    { type: Number, default: 0 },
  subscription: { type: String, enum: ['active', 'trial', 'expired', 'cancelled'], default: 'trial' },
  status:       { type: String, enum: ['active', 'banned'], default: 'active' },
  trialEndsAt:  { type: Date },
  joined:       { type: String, default: () => new Date().toISOString().split('T')[0] },
  referralTree: [referralNodeSchema],
  bankName:      { type: String, default: '' },
  bankCode:      { type: String, default: '' },
  accountNumber: { type: String, default: '' },
  accountName:   { type: String, default: '' },
  resetPasswordToken:  { type: String, default: null },
  resetPasswordExpiry: { type: Date, default: null },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
