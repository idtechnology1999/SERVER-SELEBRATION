import { Settings } from '../models/Settings.js';
import { STAGE_LABELS, STAGE_PRICES, type StageKey } from './stages.js';

export const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

// Reads the secret key from DB settings first, falls back to .env
export async function getPaystackSecret(): Promise<string> {
  const settings = await Settings.findOne().select('paystackSecret');
  return settings?.paystackSecret || process.env.PAYSTACK_SECRET_KEY || '';
}

export async function paystackPost(path: string, body: object) {
  const secret = await getPaystackSecret();
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

export async function paystackGet(path: string) {
  const secret = await getPaystackSecret();
  const res = await fetch(`https://api.paystack.co${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  return res.json() as Promise<any>;
}

export async function verifyTransaction(reference: string) {
  return paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
}

// Paystack transaction statuses that will never turn into a successful payment.
export const FINAL_FAILED_STATUSES = new Set(['failed', 'abandoned', 'reversed']);

// Monthly Paystack plan for a stage (created once, recreated if the price changes).
export async function ensureStagePlan(stage: StageKey): Promise<string> {
  const amount = STAGE_PRICES[stage] * 100;
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});

  const plans = (settings.get('stagePlans') || {}) as Record<string, { code: string; amount: number }>;
  const existing = plans[stage];
  if (existing?.code && existing.amount === amount) return existing.code;

  const data = await paystackPost('/plan', {
    name: `${STAGE_LABELS[stage]} — monthly`,
    interval: 'monthly',
    amount,
    currency: 'NGN',
  });
  if (!data.status || !data.data?.plan_code) {
    throw new Error(data.message || 'Could not create Paystack plan');
  }

  plans[stage] = { code: data.data.plan_code, amount };
  settings.set('stagePlans', plans);
  settings.markModified('stagePlans');
  await settings.save();
  return data.data.plan_code;
}

// Which stage a Paystack plan code belongs to (for renewal charges).
export async function stageForPlanCode(planCode: string): Promise<StageKey | null> {
  if (!planCode) return null;
  const settings = await Settings.findOne().select('stagePlans');
  const plans = (settings?.get('stagePlans') || {}) as Record<string, { code: string }>;
  const match = Object.entries(plans).find(([, p]) => p?.code === planCode);
  return (match?.[0] as StageKey) ?? null;
}

interface InitStagePaymentArgs {
  email: string;
  userId: string;
  stage: StageKey;
  renewal: 'auto' | 'manual';
  callbackUrl: string;
  signup?: boolean;
}

// Starts a Paystack checkout for one month of a stage.
// Auto-renew uses a Paystack plan, which only works with cards.
export async function initStagePayment({ email, userId, stage, renewal, callbackUrl, signup }: InitStagePaymentArgs) {
  const body: Record<string, unknown> = {
    email,
    amount: STAGE_PRICES[stage] * 100,
    currency: 'NGN',
    callback_url: callbackUrl,
    metadata: {
      userId,
      type: 'stage',
      stage,
      renewal,
      signup: !!signup,
      // Paystack sends the buyer here if they cancel on the checkout page.
      cancel_action: `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}cancelled=1`,
      custom_fields: [{ display_name: 'Stage', variable_name: 'stage', value: STAGE_LABELS[stage] }],
    },
  };
  if (renewal === 'auto') {
    body.plan = await ensureStagePlan(stage);
    body.channels = ['card'];
  }

  const data = await paystackPost('/transaction/initialize', body);
  if (!data.status) throw new Error(data.message || 'Failed to initialize payment');
  return {
    authorizationUrl: data.data.authorization_url as string,
    reference: data.data.reference as string,
    amount: STAGE_PRICES[stage],
  };
}

// Stops future automatic charges for a Paystack subscription.
export async function disableSubscription(code: string, emailToken: string): Promise<boolean> {
  if (!code || !emailToken) return false;
  const data = await paystackPost('/subscription/disable', { code, token: emailToken });
  return !!data.status;
}
