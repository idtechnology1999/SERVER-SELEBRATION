import { User } from '../models/User.js';
import { applyStagePayment } from './applyStagePayment.js';
import { FINAL_FAILED_STATUSES, verifyTransaction } from './paystack.js';

export type SignupPaymentState = 'paid' | 'pending' | 'failed';

interface Options {
  // Only revoke a failed/cancelled payment if the sign-up is at least this old.
  // Paystack reports "abandoned" while the buyer is still on the checkout page and a
  // declined card can be retried, so callers that may run mid-checkout pass a delay.
  minAgeToRevokeMs?: number;
  // Revoke even a still-pending payment once the sign-up is this old.
  revokePendingAfterMs?: number;
}

/**
 * For an account created from a plan button: checks its payment with Paystack.
 *  - paid    → stage unlocked (applied once)
 *  - failed  → payment failed/cancelled: the account is revoked (deleted)
 *  - pending → payment still processing (e.g. bank transfer) or checkout still open
 * Throws if Paystack can't be reached, so a network problem never revokes anyone.
 */
export async function resolvePendingSignup(userId: string, options: Options = {}): Promise<SignupPaymentState> {
  const { minAgeToRevokeMs = 0, revokePendingAfterMs } = options;

  const user = await User.findById(userId);
  if (!user) return 'failed';
  if (user.signupStatus !== 'awaiting_payment') return 'paid';

  const createdAt = (user as any).createdAt ? new Date((user as any).createdAt).getTime() : Date.now();
  const age = Date.now() - createdAt;

  const revoke = async (): Promise<SignupPaymentState> => {
    // Only delete if still unpaid (a webhook may have just applied the payment).
    const removed = await User.deleteOne({ _id: user._id, signupStatus: 'awaiting_payment' });
    return removed.deletedCount ? 'failed' : 'paid';
  };

  const reference = user.pendingPayment?.reference;
  if (!reference) return age >= minAgeToRevokeMs ? revoke() : 'pending';

  const data = await verifyTransaction(reference);
  const tx = data?.data;
  const txStatus: string = tx?.status || '';

  if (data?.status && txStatus === 'success') {
    // Make sure this payment really belongs to this account before trusting it.
    const meta = typeof tx.metadata === 'string' ? safeJson(tx.metadata) : tx.metadata;
    if (meta?.userId && meta.userId !== user._id.toString()) return 'pending';
    await applyStagePayment(tx);
    const fresh = await User.findById(userId).select('signupStatus');
    return fresh?.signupStatus === 'complete' ? 'paid' : 'pending';
  }

  // Paystack answers "Transaction reference not found" when checkout was never opened.
  const neverStarted = data?.status === false && /not found/i.test(data?.message || '');
  if ((FINAL_FAILED_STATUSES.has(txStatus) || neverStarted) && age >= minAgeToRevokeMs) return revoke();
  if (revokePendingAfterMs !== undefined && age >= revokePendingAfterMs) return revoke();

  return 'pending';
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return {}; }
}
