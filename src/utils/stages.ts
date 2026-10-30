// Single source of truth for the four paid stages, their prices and who can access what.

export const STAGE_KEYS = ['fish', 'dolphin', 'shark', 'whale'] as const;
export type StageKey = typeof STAGE_KEYS[number];

// Stage number stored on the user: 0 = never paid, 1 = Fish ... 4 = Whale.
export const STAGE_NUMBERS: Record<StageKey, number> = { fish: 1, dolphin: 2, shark: 3, whale: 4 };

// Default monthly price in Naira. The live prices are set in the admin panel
// (see utils/prices.ts); these are used until an admin saves different ones.
export const STAGE_PRICES: Record<StageKey, number> = {
  fish: 5000,
  dolphin: 15000,
  shark: 50000,
  whale: 150000,
};

export const STAGE_LABELS: Record<StageKey, string> = {
  fish: 'Fish',
  dolphin: 'Dolphin',
  shark: 'Shark',
  whale: 'Whale',
};

// Days of access kept after a paid month ends, before stages lock.
// 1 day (decided Oct 2026). Change here, or set GRACE_DAYS in the server env.
export const DEFAULT_GRACE_DAYS = 1;
export function graceDays(): number {
  const raw = process.env.GRACE_DAYS;
  const fromEnv = raw ? Number(raw) : NaN;
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_GRACE_DAYS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isStageKey(value: unknown): value is StageKey {
  return typeof value === 'string' && (STAGE_KEYS as readonly string[]).includes(value);
}

export function stageKeyFromNumber(n: number): StageKey | null {
  return STAGE_KEYS[n - 1] ?? null;
}

// Stages 1..n, e.g. 3 → fish, dolphin, shark.
export function stagesUpTo(n: number): StageKey[] {
  return STAGE_KEYS.slice(0, Math.max(0, Math.min(n, STAGE_KEYS.length)));
}

export function addOneMonth(from: Date): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + 1);
  return d;
}

interface AccessFields {
  stage?: number | null;
  subscription?: string | null;
  paidUntil?: Date | string | null;
  trialEndsAt?: Date | string | null;
}

// End of the paid month. Older accounts stored it in trialEndsAt while active.
export function paidUntilOf(user: AccessFields): Date | null {
  if (user.paidUntil) return new Date(user.paidUntil);
  if (user.subscription === 'active' && user.trialEndsAt) return new Date(user.trialEndsAt);
  return null;
}

// Paid for the current month (including the grace period).
// An admin cancelling the subscription removes access straight away.
export function isPaidUp(user: AccessFields, now = new Date(), grace = graceDays()): boolean {
  if (user.subscription !== 'active') return false;
  const until = paidUntilOf(user);
  if (!until || (user.stage ?? 0) < 1) return false;
  return until.getTime() + grace * DAY_MS > now.getTime();
}

export function isTrialActive(user: AccessFields, now = new Date()): boolean {
  return user.subscription === 'trial' && !!user.trialEndsAt && new Date(user.trialEndsAt) > now;
}

// Which stages the user can watch right now.
export function accessibleStages(user: AccessFields, now = new Date(), grace = graceDays()): StageKey[] {
  if (isPaidUp(user, now, grace)) return stagesUpTo(user.stage ?? 0);
  if (isTrialActive(user, now)) return ['fish'];
  return [];
}
