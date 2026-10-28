import { User } from '../models/User.js';
import { UsedReference } from '../models/UsedReference.js';
import { Notification } from '../models/Notification.js';
import { Admin } from '../models/Admin.js';
import { distributeCommissions } from './distributeCommissions.js';
import { disableSubscription, stageForPlanCode } from './paystack.js';
import {
  STAGE_LABELS, STAGE_NUMBERS, STAGE_PRICES, addOneMonth, isPaidUp, isStageKey, type StageKey,
} from './stages.js';
import { emit } from '../socket.js';

export type ApplyResult =
  | { status: 'applied' | 'already_applied'; userId: string; stage: StageKey }
  | { status: 'ignored'; reason: string };

function parseMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw as Record<string, any>;
}

function planCodeOf(tx: any): string {
  if (!tx.plan) return '';
  return typeof tx.plan === 'string' ? tx.plan : tx.plan.plan_code || '';
}

async function notifyAdmins(title: string, message: string) {
  const admins = await Admin.find().select('_id');
  if (admins.length === 0) return;
  await Notification.insertMany(admins.map(a => ({
    userId: a._id.toString(), userType: 'admin', title, message, type: 'system',
  })));
  emit('notification:admin', { type: 'payment_issue' });
}

/**
 * Applies a successful Paystack stage payment (first payment, upgrade or monthly renewal).
 * Safe to call more than once for the same payment: only the first call changes anything.
 * `tx` must come from Paystack (verify endpoint or a signed webhook) with status 'success'.
 */
export async function applyStagePayment(tx: any): Promise<ApplyResult> {
  if (!tx || tx.status !== 'success') return { status: 'ignored', reason: 'not_successful' };
  if (tx.currency && tx.currency !== 'NGN') return { status: 'ignored', reason: 'wrong_currency' };

  const meta = parseMetadata(tx.metadata);
  const planCode = planCodeOf(tx);

  // Work out who paid and for which stage.
  let stage: StageKey | null = null;
  let user = null;
  let renewal: 'auto' | 'manual' = 'manual';

  if (meta.type === 'stage' && isStageKey(meta.stage)) {
    stage = meta.stage;
    renewal = meta.renewal === 'auto' || planCode ? 'auto' : 'manual';
    if (meta.userId) user = await User.findById(meta.userId);
  } else if (planCode) {
    // Automatic monthly renewal charged by Paystack: no metadata, find by plan + customer.
    stage = await stageForPlanCode(planCode);
    renewal = 'auto';
    const customerCode = tx.customer?.customer_code;
    const email = tx.customer?.email?.toLowerCase();
    user = (customerCode && await User.findOne({ paystackCustomerCode: customerCode }))
      || (email && await User.findOne({ email }))
      || null;
  } else {
    return { status: 'ignored', reason: 'not_a_stage_payment' };
  }

  if (!stage) return { status: 'ignored', reason: 'unknown_stage' };

  const amountNaira = Math.round(Number(tx.amount) / 100);
  if (!Number.isFinite(amountNaira) || amountNaira < STAGE_PRICES[stage]) {
    return { status: 'ignored', reason: 'amount_too_low' };
  }

  if (!user) {
    // Paid after their unpaid sign-up was revoked (or account deleted): needs a person to sort out.
    await notifyAdmins(
      'Payment without an account',
      `Paystack payment ${tx.reference} (₦${amountNaira.toLocaleString()}, ${STAGE_LABELS[stage]}) from ${tx.customer?.email || 'unknown email'} has no matching account. Please recreate the account or refund.`,
    );
    return { status: 'ignored', reason: 'user_missing' };
  }

  const userId = user._id.toString();
  const earlierPayments = await UsedReference.countDocuments({ userId, purpose: { $in: ['stage', 'subscription'] } });

  // Claim the reference first: the unique index makes sure only one caller applies it.
  try {
    await UsedReference.create({ reference: tx.reference, userId, purpose: 'stage', amount: amountNaira });
  } catch (err: any) {
    if (err?.code === 11000) return { status: 'already_applied', userId, stage };
    throw err;
  }

  try {
    const now = new Date();
    const newStageNum = STAGE_NUMBERS[stage];
    const currentStage = user.stage ?? 0;
    const paidUp = isPaidUp(user, now);

    let nextStage = newStageNum;
    let nextPaidUntil: Date;
    if (paidUp && newStageNum === currentStage) {
      // Renewal of the same stage: add a month on top of the current one.
      nextPaidUntil = addOneMonth(new Date(user.paidUntil ?? now));
    } else if (paidUp && newStageNum < currentStage) {
      // Shouldn't happen (lower stages are blocked when starting a payment), e.g. an old
      // auto-renew plan that failed to cancel. Keep the higher stage and flag it.
      nextStage = currentStage;
      nextPaidUntil = new Date(user.paidUntil ?? now);
      await notifyAdmins(
        'Lower-stage payment received',
        `${user.email} paid ₦${amountNaira.toLocaleString()} for ${STAGE_LABELS[stage]} while on a higher stage (ref ${tx.reference}). Please check and refund if needed.`,
      );
    } else {
      // New stage, upgrade, or paying again after the month ran out: a fresh month from today.
      nextPaidUntil = addOneMonth(now);
    }

    const update: Record<string, unknown> = {
      stage: nextStage,
      paidUntil: nextPaidUntil,
      subscription: 'active',
      signupStatus: 'complete',
      pendingPayment: { reference: '', stage: '', renewal: '' },
    };

    if (renewal === 'auto' && planCode) {
      update.renewal = 'auto';
      update.paystackPlanCode = planCode;
      if (tx.customer?.customer_code) update.paystackCustomerCode = tx.customer.customer_code;
    } else if (meta.type === 'stage') {
      update.renewal = 'manual';
    }

    // Upgrading or switching plans: stop the old automatic plan so they aren't charged twice.
    const oldSub = user.paystackSubscriptionCode;
    const oldToken = user.paystackEmailToken;
    const oldPlan = user.paystackPlanCode;
    if (oldSub && oldPlan && oldPlan !== planCode) {
      await disableSubscription(oldSub, oldToken).catch(() => false);
      if (renewal !== 'auto') {
        update.paystackSubscriptionCode = '';
        update.paystackEmailToken = '';
        update.paystackPlanCode = '';
      }
    }

    await User.findByIdAndUpdate(userId, update);
  } catch (err) {
    // Access wasn't granted: release the claim so a retry (webhook or return page) can apply it.
    await UsedReference.deleteOne({ reference: tx.reference }).catch(() => {});
    throw err;
  }

  // Access is granted from here on; a failure below must not undo or repeat it.
  const finalUser = await User.findById(userId).select('paidUntil');
  try {
    await distributeCommissions(userId, amountNaira, { firstPayment: earlierPayments === 0 });
  } catch (err: any) {
    console.error('[applyStagePayment] commissions failed for', tx.reference, err.message);
    await notifyAdmins('Commission error', `Commissions for payment ${tx.reference} could not be created: ${err.message}`).catch(() => {});
  }

  try {
    const untilText = finalUser?.paidUntil
      ? new Date(finalUser.paidUntil).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    await Notification.create({
      userId,
      userType: 'student',
      title: `${STAGE_LABELS[stage]} payment received`,
      message: `Thanks! Your ${STAGE_LABELS[stage]} plan is active${untilText ? ` until ${untilText}` : ''}.`,
      type: 'system',
    });
    emit('notification:new', { userId });
    emit('payment:new', { userId, user: user.name || user.email, amount: amountNaira, date: new Date().toISOString() });
  } catch (err: any) {
    console.error('[applyStagePayment] notification failed for', tx.reference, err.message);
  }

  return { status: 'applied', userId, stage };
}
