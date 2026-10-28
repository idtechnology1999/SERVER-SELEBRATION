import { accessibleStages, isPaidUp, paidUntilOf } from './stages.js';

// Account details sent to the website (never includes passwords, codes or Paystack tokens).
export function publicUser(user: any) {
  const paidUntil = paidUntilOf(user);
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone,
    referralCode: user.referralCode,
    referredBy: user.referredBy,
    stage: user.stage ?? 0,
    subscription: user.subscription,
    trialEndsAt: user.subscription === 'trial' && user.trialEndsAt ? new Date(user.trialEndsAt).toISOString() : undefined,
    paidUntil: paidUntil ? paidUntil.toISOString() : undefined,
    paidUp: isPaidUp(user),
    unlockedStages: accessibleStages(user),
    renewal: user.renewal || 'manual',
    autoRenewActive: !!user.paystackSubscriptionCode,
    emailVerified: user.emailVerified !== false,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : undefined,
  };
}
