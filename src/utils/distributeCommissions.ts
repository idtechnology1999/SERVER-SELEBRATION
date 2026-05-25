import type { Document } from 'mongoose';
import { User } from '../models/User.js';
import { Commission } from '../models/Commission.js';

// Commission rates by referral level (must sum to ≤ 100%)
const RATES: Record<number, number> = {
  1: 0.65,
  2: 0.15,
  3: 0.05,
  4: 0.03,
  5: 0.02,
  6: 0.01,
};

/**
 * Walk up the referral chain from the subscriber and create Commission
 * records for each qualifying affiliate (up to 6 levels).
 *
 * @param subscriberId  MongoDB _id of the user who just subscribed
 * @param amountNaira   Subscription price in Naira (e.g. 5000)
 * @param courseId      Optional — for record keeping
 */
export async function distributeCommissions(
  subscriberId: string,
  amountNaira: number,
  courseId?: string
): Promise<void> {
  const subscriber = await User.findById(subscriberId);
  if (!subscriber || !subscriber.referredBy) return;

  let currentReferralCode: string | null = subscriber.referredBy;
  let level = 1;

  while (currentReferralCode && level <= 6) {
    const affiliate: (Document & Record<string, any>) | null = await User.findOne({ referralCode: currentReferralCode });
    if (!affiliate) break;

    // CRITICAL: Only pay commissions if the affiliate has an ACTIVE subscription
    if (affiliate.subscription !== 'active') {
      currentReferralCode = affiliate.referredBy || null;
      level++;
      continue;
    }

    const rate = RATES[level];
    const commission = Math.floor(amountNaira * rate);

    if (commission > 0) {
      await Commission.create({
        payer: subscriberId,
        beneficiary: affiliate._id.toString(),
        level,
        amount: commission,
        course: courseId || null,
        status: 'pending',
      });

      // Increment the affiliate's referral count on level-1 only
      if (level === 1) {
        await User.findByIdAndUpdate(affiliate._id, { $inc: { referrals: 1 } });
      }
    }

    currentReferralCode = affiliate.referredBy || null;
    level++;
  }
}
