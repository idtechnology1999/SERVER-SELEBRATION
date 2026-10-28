import cron from 'node-cron';
import { User } from '../models/User.js';
import { resolvePendingSignup } from '../utils/pendingSignup.js';

const HOUR_MS = 60 * 60 * 1000;

// Sign-ups from a plan button that never came back from Paystack:
// after 1 hour, paid ones are unlocked and failed/cancelled ones are revoked.
// A payment still "processing" (e.g. a bank transfer) gets up to 24 hours.
async function runPendingSignupCleanup() {
  const cutoff = new Date(Date.now() - HOUR_MS);
  const pending = await User.find({ signupStatus: 'awaiting_payment', createdAt: { $lt: cutoff } }).select('_id');

  let paid = 0, revoked = 0, waiting = 0;
  for (const u of pending) {
    try {
      const state = await resolvePendingSignup(u._id.toString(), {
        minAgeToRevokeMs: HOUR_MS,
        revokePendingAfterMs: 24 * HOUR_MS,
      });
      if (state === 'paid') paid++;
      else if (state === 'failed') revoked++;
      else waiting++;
    } catch (err: any) {
      // Paystack unreachable: leave it for the next run.
      console.error('[pendingSignupCleanup] check failed for', u._id.toString(), err.message);
      waiting++;
    }
  }

  if (pending.length > 0) {
    console.log(`[pendingSignupCleanup] paid ${paid}, revoked ${revoked}, still waiting ${waiting}`);
  }
}

export function startPendingSignupCleanupJob() {
  cron.schedule('15 * * * *', () => {
    runPendingSignupCleanup().catch(err => console.error('[pendingSignupCleanup] Error:', err.message));
  });
  console.log('[pendingSignupCleanup] Unpaid sign-up check scheduled (every hour)');
}
