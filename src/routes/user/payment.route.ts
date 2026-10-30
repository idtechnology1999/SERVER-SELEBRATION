import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { requireUserAuth, type UserAuthRequest } from '../../middleware/userAuth.js';
import { User } from '../../models/User.js';
import { Course } from '../../models/Course.js';
import { ModuleUnlock } from '../../models/ModuleUnlock.js';
import { UsedReference } from '../../models/UsedReference.js';
import { Notification } from '../../models/Notification.js';
import { applyStagePayment } from '../../utils/applyStagePayment.js';
import { publicUser } from '../../utils/publicUser.js';
import { sendMail } from '../../utils/mailer.js';
import {
  FRONTEND_URL, getPaystackSecret, paystackGet, paystackPost, initStagePayment, verifyTransaction,
  disableSubscription, stageForPlanCode,
} from '../../utils/paystack.js';
import { STAGE_LABELS, STAGE_NUMBERS, isPaidUp, isStageKey } from '../../utils/stages.js';
import { emit } from '../../socket.js';

const router = Router();

// ── Stage payments (logged-in users: upgrade, renew, or pay after the month ran out) ──

// POST /payment/init-stage  { stage, renewal: 'auto' | 'manual' }
router.post('/init-stage', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { stage } = req.body;
    const renewal = req.body.renewal === 'auto' ? 'auto' : 'manual';
    if (!isStageKey(stage)) {
      res.status(400).json({ success: false, message: 'Invalid stage' });
      return;
    }

    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const paidUp = isPaidUp(user);
    const current = user.stage ?? 0;
    if (paidUp && STAGE_NUMBERS[stage] < current) {
      res.status(400).json({ success: false, message: 'You already have a higher plan this month.' });
      return;
    }
    if (paidUp && STAGE_NUMBERS[stage] === current && user.paystackSubscriptionCode) {
      res.status(400).json({ success: false, message: 'Your plan already renews automatically each month.' });
      return;
    }

    const payment = await initStagePayment({
      email: user.email,
      userId: user._id.toString(),
      stage,
      renewal,
      callbackUrl: `${FRONTEND_URL()}/dashboard/subscribe/callback?type=stage&stage=${stage}`,
    });

    res.json({ success: true, data: payment });
  } catch (err: any) {
    console.error('[init-stage error]', err.message);
    res.status(502).json({ success: false, message: 'Could not start the payment. Please try again.' });
  }
});

// GET /payment/verify-stage?reference=...
// Safe to call even if the webhook already applied this payment.
router.get('/verify-stage', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { reference } = req.query;
    if (!reference || typeof reference !== 'string') {
      res.status(400).json({ success: false, message: 'Reference required' });
      return;
    }

    const data = await verifyTransaction(reference);
    const tx = data?.data;
    if (!data?.status || tx?.status !== 'success') {
      res.status(400).json({ success: false, message: tx?.gateway_response || 'Payment not successful' });
      return;
    }

    const meta = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata || '{}') : (tx.metadata || {});
    if (meta.userId && meta.userId !== req.user!.id) {
      res.status(403).json({ success: false, message: 'This payment belongs to another account' });
      return;
    }

    const result = await applyStagePayment(tx);
    if (result.status === 'ignored') {
      res.status(400).json({ success: false, message: 'This payment could not be applied. Please contact support.' });
      return;
    }

    const user = await User.findById(req.user!.id).select('-password');
    res.json({
      success: true,
      message: `${STAGE_LABELS[result.stage]} plan active!`,
      data: { stage: result.stage, user: user ? publicUser(user) : undefined },
    });
  } catch (err: any) {
    console.error('[verify-stage error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /payment/renewal  { mode: 'manual' } — turn off automatic renewal
router.post('/renewal', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    if (req.body.mode !== 'manual') {
      res.status(400).json({ success: false, message: 'To turn on automatic renewal, renew your plan with a card and choose "Renew automatically".' });
      return;
    }
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    if (user.paystackSubscriptionCode) {
      const ok = await disableSubscription(user.paystackSubscriptionCode, user.paystackEmailToken);
      if (!ok) {
        res.status(502).json({ success: false, message: 'Could not turn off automatic renewal. Please try again.' });
        return;
      }
    }
    await User.findByIdAndUpdate(user._id, {
      renewal: 'manual', paystackSubscriptionCode: '', paystackEmailToken: '', paystackPlanCode: '',
    });
    res.json({ success: true, message: 'Automatic renewal is off. Your plan stays active until the end of the month.' });
  } catch (err: any) {
    console.error('[renewal error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Single module purchases ──

// Initiate payment for a single module
router.post('/init-module', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { courseId, moduleId } = req.body;
    if (!courseId || !moduleId) {
      res.status(400).json({ success: false, message: 'courseId and moduleId are required' });
      return;
    }

    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    // Check already unlocked
    const existing = await ModuleUnlock.findOne({ userId: req.user!.id, moduleId });
    if (existing) {
      res.status(400).json({ success: false, message: 'Module already unlocked' });
      return;
    }

    const course = await Course.findById(courseId);
    if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }

   const mod = ((course as any).modules as any[])?.find(
     (m: any) => m._id.toString() === moduleId,
   );
    if (!mod) { res.status(404).json({ success: false, message: 'Module not found' }); return; }
    if (mod.isFree) { res.status(400).json({ success: false, message: 'Module is free' }); return; }

    const price = mod.price || 0;
    if (price <= 0) {
      res.status(400).json({ success: false, message: 'Module has no price set' });
      return;
    }

    const callbackUrl = `${FRONTEND_URL()}/dashboard/subscribe/callback?type=module&moduleId=${moduleId}&courseId=${courseId}`;
    const data = await paystackPost('/transaction/initialize', {
      email: user.email,
      amount: price * 100,
      currency: 'NGN',
      callback_url: callbackUrl,
      metadata: {
        userId: user._id.toString(),
        type: 'module',
        moduleId,
        courseId,
        moduleName: mod.title,
        custom_fields: [
          { display_name: 'Module', variable_name: 'module', value: mod.title },
        ],
      },
    });

    if (!data.status) {
      res.status(502).json({ success: false, message: data.message || 'Failed to initialize payment' });
      return;
    }

    res.json({
      success: true,
      data: { authorizationUrl: data.data.authorization_url, reference: data.data.reference, amount: price },
    });
  } catch (err: any) {
    console.error('[init-module error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Verify module payment
router.get('/verify-module', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { reference } = req.query;
    if (!reference || typeof reference !== 'string') {
      res.status(400).json({ success: false, message: 'Reference required' });
      return;
    }

    const used = await UsedReference.findOne({ reference });
    if (used) {
      res.status(400).json({ success: false, message: 'Payment already processed' });
      return;
    }

    const data = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!data.status || data.data?.status !== 'success') {
      res.status(400).json({ success: false, message: data.data?.gateway_response || 'Payment not successful' });
      return;
    }

    const tx = data.data;
    const { moduleId, courseId, type } = tx.metadata || {};

    if (type !== 'module' || !moduleId || !courseId) {
      res.status(400).json({ success: false, message: 'Invalid payment type' });
      return;
    }

    const course = await Course.findById(courseId);
    if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }

    const mod = ((course as any).modules as any[])?.find(
      (m: any) => m._id.toString() === moduleId,
    );
    if (!mod) { res.status(404).json({ success: false, message: 'Module not found' }); return; }

    if (tx.amount < (mod.price ?? 0) * 100) {
      res.status(400).json({ success: false, message: 'Payment amount does not match price' });
      return;
    }

    const userId = req.user!.id;

    await UsedReference.create({ reference, userId, purpose: 'module', amount: tx.amount / 100 });

    await ModuleUnlock.findOneAndUpdate(
      { userId, moduleId },
      { userId, courseId, moduleId, amount: tx.amount / 100, reference },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Module unlocked!', data: { moduleId, courseId } });
  } catch (err: any) {
    console.error('[verify-module error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/verify-account', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) {
      res.status(400).json({ success: false, message: 'Account number and bank code are required' });
      return;
    }

    const data = await paystackGet(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);

    if (!data.status || !data.data) {
      res.status(400).json({ success: false, message: data.message || 'Could not verify account' });
      return;
    }

    res.json({
      success: true,
      data: {
        account_name: data.data.account_name,
        account_number: data.data.account_number,
      },
    });
  } catch (err: any) {
    console.error('[verify-account error]', err.message);
    res.status(500).json({ success: false, message: 'Failed to verify account' });
  }
});

// ── Paystack webhook: Paystack tells us directly about payments and auto-renewals ──

async function findUserForPaystack(data: any) {
  const subCode = data?.subscription_code || data?.subscription?.subscription_code;
  const customerCode = data?.customer?.customer_code;
  const email = data?.customer?.email?.toLowerCase();
  return (subCode && await User.findOne({ paystackSubscriptionCode: subCode }))
    || (customerCode && await User.findOne({ paystackCustomerCode: customerCode }))
    || (email && await User.findOne({ email }))
    || null;
}

router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-paystack-signature'] as string;
    const rawBody: Buffer = (req as any).rawBody;
    if (!rawBody || !signature) {
      res.status(400).json({ success: false });
      return;
    }

    const secret = await getPaystackSecret();
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    if (hash.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
      res.status(401).json({ success: false });
      return;
    }

    const event = JSON.parse(rawBody.toString());
    const data = event.data || {};

    switch (event.event) {
      case 'charge.success': {
        const meta = typeof data.metadata === 'string' ? JSON.parse(data.metadata || '{}') : (data.metadata || {});
        // Module purchases are confirmed by /verify-module; everything else is a stage payment.
        if (meta.type !== 'module') await applyStagePayment(data);
        break;
      }

      case 'subscription.create': {
        // Auto-renew started: remember the codes so we can renew and cancel it.
        const user = await findUserForPaystack(data);
        if (!user) break;
        const newCode = data.subscription_code;
        if (user.paystackSubscriptionCode && user.paystackSubscriptionCode !== newCode) {
          // Switched plans: make sure the old plan stops charging.
          await disableSubscription(user.paystackSubscriptionCode, user.paystackEmailToken).catch(() => false);
        }
        await User.findByIdAndUpdate(user._id, {
          renewal: 'auto',
          paystackSubscriptionCode: newCode || '',
          paystackEmailToken: data.email_token || '',
          paystackPlanCode: data.plan?.plan_code || user.paystackPlanCode,
          paystackCustomerCode: data.customer?.customer_code || user.paystackCustomerCode,
        });
        break;
      }

      case 'subscription.disable':
      case 'subscription.not_renew': {
        const user = await findUserForPaystack(data);
        if (!user || user.paystackSubscriptionCode !== data.subscription_code) break;
        await User.findByIdAndUpdate(user._id, {
          renewal: 'manual', paystackSubscriptionCode: '', paystackEmailToken: '', paystackPlanCode: '',
        });
        await Notification.create({
          userId: user._id.toString(), userType: 'student', type: 'system',
          title: 'Automatic renewal is off',
          message: 'Your plan will not renew automatically. Renew from Settings before it ends to keep access.',
        });
        emit('notification:new', { userId: user._id.toString() });
        break;
      }

      case 'invoice.payment_failed': {
        const user = await findUserForPaystack(data);
        if (!user) break;
        const stage = await stageForPlanCode(data.subscription?.plan?.plan_code || data.plan?.plan_code || user.paystackPlanCode);
        const label = stage ? STAGE_LABELS[stage] : 'your';
        const message = `We couldn't charge your card for ${label === 'your' ? 'your' : `your ${label}`} plan this month. Please renew from Settings to keep access.`;
        await Notification.create({
          userId: user._id.toString(), userType: 'student', type: 'system',
          title: 'Card payment failed', message,
        });
        emit('notification:new', { userId: user._id.toString() });
        await sendMail(user.email, 'We could not renew your Selliberation plan', `
          <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
            <h2 style="color:#0D2847;">Card payment failed</h2>
            <p>Hi <strong>${user.name}</strong>, ${message}</p>
            <p style="text-align:center;margin:28px 0;">
              <a href="${FRONTEND_URL()}/dashboard/settings" style="display:inline-block;background:#F5820A;color:#fff;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:8px;">Renew now →</a>
            </p>
          </div>
        `).catch((err: any) => console.error('[webhook mail error]', err.message));
        break;
      }
    }

    res.sendStatus(200);
  } catch (err: any) {
    console.error('[webhook error]', err.message);
    // Non-200 makes Paystack retry later, which is what we want if something failed.
    res.sendStatus(500);
  }
});

export default router;
