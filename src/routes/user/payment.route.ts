import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { requireUserAuth, type UserAuthRequest } from '../../middleware/userAuth.js';
import { User } from '../../models/User.js';
import { Course } from '../../models/Course.js';
import { ModuleUnlock } from '../../models/ModuleUnlock.js';
import { distributeCommissions } from '../../utils/distributeCommissions.js';
import { emit } from '../../socket.js';

const router = Router();

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

const STAGE_PRICES: Record<string, number> = { fish: 5000, shark: 15000, whale: 150000 };
const STAGE_NUMBERS: Record<string, number> = { fish: 1, shark: 2, whale: 3 };

// Reads secret key from DB settings first, falls back to .env
async function getPaystackSecret(): Promise<string> {
  const { Settings } = await import('../../models/index.js');
  const settings = await Settings.findOne().select('paystackSecret');
  return settings?.paystackSecret || process.env.PAYSTACK_SECRET_KEY || '';
}

// Get subscription price from DB settings
async function getSubscriptionPrice(): Promise<number> {
  const { Settings } = await import('../../models/index.js');
  const settings = await Settings.findOne().select('subscriptionPrice');
  return settings?.subscriptionPrice ?? 5000;
}

async function paystackPost(path: string, body: object) {
  const secret = await getPaystackSecret();
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

async function paystackGet(path: string) {
  const secret = await getPaystackSecret();
  const res = await fetch(`https://api.paystack.co${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  return res.json() as Promise<any>;
}

router.post('/init', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (user.subscription === 'active') {
      res.status(400).json({ success: false, message: 'You already have an active subscription' });
      return;
    }

    const price = await getSubscriptionPrice();
    const amountKobo = price * 100;
    const callbackUrl = `${FRONTEND_URL()}/dashboard/subscribe/callback`;

    const data = await paystackPost('/transaction/initialize', {
      email: user.email,
      amount: amountKobo,
      currency: 'NGN',
      callback_url: callbackUrl,
      metadata: {
        userId: user._id.toString(),
        custom_fields: [
          { display_name: 'Name', variable_name: 'name', value: user.name },
        ],
      },
    });

    if (!data.status) {
      res.status(502).json({ success: false, message: data.message || 'Failed to initialize payment' });
      return;
    }

    res.json({
      success: true,
      data: {
        authorizationUrl: data.data.authorization_url,
        reference: data.data.reference,
        amount: price,
      },
    });
  } catch (err: any) {
    console.error('[payment init error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/verify', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { reference } = req.query;
    if (!reference || typeof reference !== 'string') {
      res.status(400).json({ success: false, message: 'Payment reference is required' });
      return;
    }

    const data = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);

    if (!data.status || data.data?.status !== 'success') {
      res.status(400).json({
        success: false,
        message: data.data?.gateway_response || 'Payment was not successful',
      });
      return;
    }

    const tx = data.data;
    const userId = tx.metadata?.userId || req.user!.id;
    const price = await getSubscriptionPrice();

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (user.subscription !== 'active') {
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      await User.findByIdAndUpdate(userId, {
        subscription: 'active',
        trialEndsAt: nextMonth,
      });

      await distributeCommissions(userId, price);

      emit('payment:new', {
        userId,
        user: user.name || user.email,
        amount: price,
        date: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      message: 'Subscription activated!',
      data: { reference, amount: tx.amount / 100 },
    });
  } catch (err: any) {
    console.error('[payment verify error]', err.message);
    res.status(500).json({ success: false, message: 'Server error during verification' });
  }
});

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

    const data = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!data.status || data.data?.status !== 'success') {
      res.status(400).json({ success: false, message: data.data?.gateway_response || 'Payment not successful' });
      return;
    }

    const tx = data.data;
    const { userId, moduleId, courseId, type } = tx.metadata || {};

    if (type !== 'module' || !moduleId || !courseId) {
      res.status(400).json({ success: false, message: 'Invalid payment type' });
      return;
    }

    const actualUserId = userId || req.user!.id;
    await ModuleUnlock.findOneAndUpdate(
      { userId: actualUserId, moduleId },
      { userId: actualUserId, courseId, moduleId, amount: tx.amount / 100, reference },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Module unlocked!', data: { moduleId, courseId } });
  } catch (err: any) {
    console.error('[verify-module error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/init-stage', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { stage } = req.body;
    if (!STAGE_PRICES[stage]) {
      res.status(400).json({ success: false, message: 'Invalid stage' });
      return;
    }

    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    if ((user.stage ?? 0) >= STAGE_NUMBERS[stage]) {
      res.status(400).json({ success: false, message: 'Stage already unlocked' });
      return;
    }

    const price = STAGE_PRICES[stage];
    const callbackUrl = `${FRONTEND_URL()}/dashboard/subscribe/callback?type=stage&stage=${stage}`;

    const data = await paystackPost('/transaction/initialize', {
      email: user.email,
      amount: price * 100,
      currency: 'NGN',
      callback_url: callbackUrl,
      metadata: {
        userId: user._id.toString(),
        type: 'stage',
        stage,
        custom_fields: [{ display_name: 'Stage', variable_name: 'stage', value: stage }],
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
    console.error('[init-stage error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/verify-stage', requireUserAuth, async (req: UserAuthRequest, res: Response) => {
  try {
    const { reference } = req.query;
    if (!reference || typeof reference !== 'string') {
      res.status(400).json({ success: false, message: 'Reference required' });
      return;
    }

    const data = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!data.status || data.data?.status !== 'success') {
      res.status(400).json({ success: false, message: data.data?.gateway_response || 'Payment not successful' });
      return;
    }

    const tx = data.data;
    const { userId, stage } = tx.metadata || {};

    if (!stage || !STAGE_NUMBERS[stage]) {
      res.status(400).json({ success: false, message: 'Invalid payment metadata' });
      return;
    }

    const stageNum = STAGE_NUMBERS[stage];
    const actualUserId = userId || req.user!.id;

    const user = await User.findById(actualUserId);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    if ((user.stage ?? 0) < stageNum) {
      await User.findByIdAndUpdate(actualUserId, { stage: stageNum, subscription: 'active' });
      await distributeCommissions(actualUserId, tx.amount / 100);
      emit('payment:new', {
        userId: actualUserId,
        user: user.name || user.email,
        amount: tx.amount / 100,
        date: new Date().toISOString(),
      });
    }

    res.json({ success: true, message: `${stage.charAt(0).toUpperCase() + stage.slice(1)} stage unlocked!`, data: { stage, stageNum } });
  } catch (err: any) {
    console.error('[verify-stage error]', err.message);
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

router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-paystack-signature'] as string;
    const rawBody: Buffer = (req as any).rawBody;

    if (!rawBody || !signature) {
      res.status(400).json({ success: false });
      return;
    }

    const secret = await getPaystackSecret();
    const hash = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');

    if (hash !== signature) {
      res.status(401).json({ success: false });
      return;
    }

    const event = JSON.parse(rawBody.toString());

    if (event.event === 'charge.success') {
      const tx = event.data;
      const userId = tx.metadata?.userId;
      if (!userId) { res.sendStatus(200); return; }

      const user = await User.findById(userId);
      if (!user) { res.sendStatus(200); return; }

      if (user.subscription !== 'active') {
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        await User.findByIdAndUpdate(userId, {
          subscription: 'active',
          trialEndsAt: nextMonth,
        });

        await distributeCommissions(userId, tx.amount / 100);
      }
    }

    res.sendStatus(200);
  } catch (err: any) {
    console.error('[webhook error]', err.message);
    res.sendStatus(200);
  }
});

export default router;
