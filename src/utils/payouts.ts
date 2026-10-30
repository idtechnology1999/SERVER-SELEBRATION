import { Commission } from '../models/Commission.js';
import { Withdrawal } from '../models/Withdrawal.js';
import { Settings } from '../models/Settings.js';

// Weekly payout: commissions earned during the week become withdrawable every
// Thursday at 10pm Nigeria time (WAT, UTC+1, no daylight saving).
export const PAYOUT_TIMEZONE = 'Africa/Lagos';
export const PAYOUT_CRON = '0 22 * * 4'; // Thursday 22:00 in PAYOUT_TIMEZONE
const PAYOUT_WEEKDAY = 4;                // Thursday
const PAYOUT_HOUR_UTC = 21;              // 22:00 WAT
export const DEFAULT_MIN_WITHDRAWAL = 10000;

// The next Thursday 10pm WAT after `now` (or the current one, if it's later today).
export function nextPayoutRelease(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), PAYOUT_HOUR_UTC, 0, 0));
  let addDays = (PAYOUT_WEEKDAY - d.getUTCDay() + 7) % 7;
  if (addDays === 0 && d.getTime() <= now.getTime()) addDays = 7;
  d.setUTCDate(d.getUTCDate() + addDays);
  return d;
}

// The most recent Thursday 10pm WAT at or before `now`.
export function lastPayoutRelease(now = new Date()): Date {
  const next = nextPayoutRelease(now);
  return new Date(next.getTime() - 7 * 24 * 60 * 60 * 1000);
}

export async function minWithdrawal(): Promise<number> {
  const s = await Settings.findOne().select('minWithdrawal');
  const n = Number(s?.minWithdrawal);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_WITHDRAWAL;
}

// Makes everything earned up to `cutoff` withdrawable. Returns how many were released.
export async function releaseCommissions(cutoff = new Date()): Promise<number> {
  const res = await Commission.updateMany(
    { status: 'pending', createdAt: { $lte: cutoff } },
    { status: 'withdrawable' },
  );
  return res.modifiedCount;
}

export interface Balance {
  totalEarned: number;        // every commission ever earned
  pending: number;            // earned this week, released on Thursday
  available: number;          // can be requested now
  inWithdrawal: number;       // requested, waiting for admin approval
  withdrawn: number;          // paid out
  nextReleaseAt: string;
}

/**
 * Money is tracked as: released commissions − withdrawals (pending + approved).
 * A partial withdrawal only takes what was requested; the rest stays available.
 */
export async function balanceFor(userId: string, now = new Date()): Promise<Balance> {
  const [commissions, withdrawals] = await Promise.all([
    Commission.find({ beneficiary: userId }).select('amount status'),
    Withdrawal.find({ user: userId, status: { $in: ['pending', 'approved'] } }).select('amount status'),
  ]);

  let totalEarned = 0, pending = 0, released = 0;
  for (const c of commissions) {
    totalEarned += c.amount;
    if (c.status === 'pending') pending += c.amount;
    else released += c.amount; // 'withdrawable' or (older data) 'withdrawn'
  }

  let inWithdrawal = 0, withdrawn = 0;
  for (const w of withdrawals) {
    if (w.status === 'pending') inWithdrawal += w.amount;
    else withdrawn += w.amount;
  }

  return {
    totalEarned,
    pending,
    available: Math.max(0, released - inWithdrawal - withdrawn),
    inWithdrawal,
    withdrawn,
    nextReleaseAt: nextPayoutRelease(now).toISOString(),
  };
}
