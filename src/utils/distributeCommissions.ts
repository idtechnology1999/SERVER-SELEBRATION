import type { Document } from 'mongoose';
import { User } from '../models/User.js';
import { Commission } from '../models/Commission.js';
import { Settings } from '../models/Settings.js';
import { isPaidUp } from './stages.js';

// Fallback rates by referral level, used when admin settings are missing.
export const DEFAULT_RATES: Record<number, number> = {
  1: 0.65,
  2: 0.15,
  3: 0.05,
  4: 0.03,
  5: 0.02,
  6: 0.01,
};

// Rates set in the admin panel (stored as percentages, e.g. 65).
async function loadRates(): Promise<Record<number, number>> {
  const s: any = await Settings.findOne().select(
    'commissionLevel1 commissionLevel2 commissionLevel3 commissionLevel4 commissionLevel5 commissionLevel6',
  );
  const rates: Record<number, number> = { ...DEFAULT_RATES };
  if (!s) return rates;
  for (let level = 1; level <= 6; level++) {
    const pct = Number(s[`commissionLevel${level}`]);
    if (Number.isFinite(pct) && pct >= 0) rates[level] = pct / 100;
  }
  return rates;
}

interface Options {
  courseId?: string;
  // The payer's first ever payment — only then does it count as a new referral.
  firstPayment?: boolean;
}

/**
 * Walk up the referral chain from the payer and create Commission records
 * for each qualifying affiliate (up to 6 levels). Runs on every payment,
 * including monthly renewals, using the amount actually paid.
 *
 * An affiliate only earns if their own month is paid up at the time of the payment;
 * otherwise that level is skipped (not passed on).
 */
export async function distributeCommissions(
  subscriberId: string,
  amountNaira: number,
  options: Options = {},
): Promise<void> {
  const subscriber = await User.findById(subscriberId);
  if (!subscriber || !subscriber.referredBy) return;

  const rates = await loadRates();
  const now = new Date();

  let currentReferralCode: string | null = subscriber.referredBy;
  let level = 1;

  while (currentReferralCode && level <= 6) {
    const affiliate: (Document & Record<string, any>) | null = await User.findOne({ referralCode: currentReferralCode });
    if (!affiliate) break;

    if (isPaidUp(affiliate as any, now)) {
      const commission = Math.floor(amountNaira * (rates[level] ?? 0));
      if (commission > 0) {
        await Commission.create({
          payer: subscriberId,
          beneficiary: affiliate._id.toString(),
          level,
          amount: commission,
          course: options.courseId || null,
          status: 'pending',
        });
      }
    }

    // Count the referral once (first payment), whether or not the affiliate earned this time.
    if (level === 1 && options.firstPayment) {
      await User.findByIdAndUpdate(affiliate._id, { $inc: { referrals: 1 } });
    }

    currentReferralCode = affiliate.referredBy || null;
    level++;
  }
}
