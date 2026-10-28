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

  // ── Paid stages (monthly) ──
  paidUntil:    { type: Date, default: null },               // end of the current paid month
  renewal:      { type: String, enum: ['auto', 'manual'], default: 'manual' },
  paystackCustomerCode:     { type: String, default: '' },
  paystackSubscriptionCode: { type: String, default: '' },   // set while auto-renew is on
  paystackEmailToken:       { type: String, default: '' },   // needed to cancel auto-renew
  paystackPlanCode:         { type: String, default: '' },

  // ── Pay-first sign-up ──
  // 'awaiting_payment': account created from a plan button, not paid yet (revoked if payment fails)
  signupStatus: { type: String, enum: ['complete', 'awaiting_payment'], default: 'complete' },
  pendingPayment: {
    reference: { type: String, default: '' },
    stage:     { type: String, default: '' },
    renewal:   { type: String, default: '' },
  },
  // Accounts created before this field existed were verified by the old flow.
  emailVerified: { type: Boolean, default: true },
  emailOtp: {
    hash:       { type: String, default: '' },
    expiresAt:  { type: Date, default: null },
    attempts:   { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
  },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
